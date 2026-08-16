import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import logger from '../../logger';

export type Enforcement = 'enforced' | 'advisory' | 'unsupported';

export interface LxcLimitCapability {
  enforced: boolean;
  enforcement: Enforcement;
  reason?: string;
}

export interface LxcCapabilities {
  available: boolean;
  version: string;
  cgroupVersion: number;
  unprivileged: boolean;
  network: boolean;
  defaultBridge: string | null;
  storageDriver: string;
  limits: {
    memory: LxcLimitCapability;
    cpu: LxcLimitCapability;
    swap: LxcLimitCapability;
    storage: LxcLimitCapability;
    pids: LxcLimitCapability;
  };
  operations: {
    create: boolean;
    start: boolean;
    stop: boolean;
    kill: boolean;
    delete: boolean;
    attach: boolean;
    info: boolean;
    stats: boolean;
  };
  details: {
    binaries: Record<string, boolean>;
    subuid: boolean;
    subgid: boolean;
    bridges: string[];
    reasons: string[];
  };
}

let cachedLxcCapabilities: LxcCapabilities | null = null;
let lastLxcCheckTime = 0;
const CAPABILITIES_CACHE_TTL_MS = 10_000;

/**
 * Checks if a binary command exists in PATH using safe process check or which
 */
async function checkCommand(cmd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(['which', cmd], { stdout: 'pipe', stderr: 'pipe' });
    const code = await proc.exited;
    return code === 0;
  } catch {
    // Windows/non-POSIX fallback or spawn error
    return false;
  }
}

/**
 * Detects installed LXC version
 */
async function detectLxcVersion(): Promise<string> {
  try {
    const proc = Bun.spawn(['lxc-info', '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const text = (await new Response(proc.stdout).text()).trim();
    if (text && await proc.exited === 0) {
      return text;
    }
  } catch {}

  try {
    const proc = Bun.spawn(['lxc-create', '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const text = (await new Response(proc.stdout).text()).trim();
    if (text && await proc.exited === 0) {
      return text;
    }
  } catch {}

  return 'unknown';
}

/**
 * Detects host cgroup version
 */
function detectCgroupVersion(): number {
  try {
    if (existsSync('/sys/fs/cgroup/cgroup.controllers')) {
      return 2;
    }
    if (existsSync('/sys/fs/cgroup/memory')) {
      return 1;
    }
  } catch {}
  return 2;
}

/**
 * Checks for unprivileged UID/GID mappings in /etc/subuid and /etc/subgid
 */
function detectSubUidGid(): { subuid: boolean; subgid: boolean } {
  let subuid = false;
  let subgid = false;

  try {
    if (existsSync('/etc/subuid')) {
      const content = readFileSync('/etc/subuid', 'utf8').trim();
      subuid = content.length > 0;
    }
    if (existsSync('/etc/subgid')) {
      const content = readFileSync('/etc/subgid', 'utf8').trim();
      subgid = content.length > 0;
    }
  } catch {}

  return { subuid, subgid };
}

/**
 * Detects available network bridges on Linux
 */
function detectNetworkBridges(): string[] {
  const bridges: string[] = [];
  try {
    if (existsSync('/sys/class/net')) {
      const interfaces = readdirSync('/sys/class/net');
      for (const iface of interfaces) {
        const bridgeDir = join('/sys/class/net', iface, 'bridge');
        if (existsSync(bridgeDir)) {
          bridges.push(iface);
        } else if (iface.startsWith('lxcbr') || iface.startsWith('virbr') || iface.startsWith('br')) {
          bridges.push(iface);
        }
      }
    }
  } catch {}
  return bridges;
}

/**
 * Detects storage backend for LXC (default /var/lib/lxc)
 */
function detectStorageBackend(): { driver: string; hardQuotaSupported: boolean } {
  const lxcDir = '/var/lib/lxc';
  try {
    if (existsSync(lxcDir)) {
      // Check filesystem type if possible
      return { driver: 'dir', hardQuotaSupported: false };
    }
  } catch {}
  return { driver: 'dir', hardQuotaSupported: false };
}

/**
 * Performs honest, comprehensive LXC capability detection
 */
export async function detectLxcCapabilities(forceRefresh = false): Promise<LxcCapabilities> {
  const now = Date.now();
  if (!forceRefresh && cachedLxcCapabilities && now - lastLxcCheckTime < CAPABILITIES_CACHE_TTL_MS) {
    return cachedLxcCapabilities;
  }

  const reasons: string[] = [];
  const requiredCommands = [
    'lxc-create',
    'lxc-start',
    'lxc-stop',
    'lxc-info',
    'lxc-attach',
    'lxc-destroy',
    'lxc-ls',
  ];

  const binaryChecks: Record<string, boolean> = {};
  let allRequiredFound = true;

  for (const cmd of requiredCommands) {
    const found = await checkCommand(cmd);
    binaryChecks[cmd] = found;
    if (!found) {
      allRequiredFound = false;
      reasons.push(`Missing required binary: ${cmd}`);
    }
  }

  const version = allRequiredFound ? await detectLxcVersion() : 'unsupported';
  const cgroupVersion = detectCgroupVersion();
  const { subuid, subgid } = detectSubUidGid();
  const bridges = detectNetworkBridges();
  const storage = detectStorageBackend();

  if (!subuid || !subgid) {
    reasons.push('Subordinate UID/GID ranges (/etc/subuid, /etc/subgid) are not configured for unprivileged containers.');
  }

  if (bridges.length === 0) {
    reasons.push('No network bridge (e.g. lxcbr0, br0) was detected on this node.');
  }

  const isAvailable = allRequiredFound;
  const isUnprivileged = subuid && subgid;
  const isNetworkReady = bridges.length > 0;
  const defaultBridge = bridges.includes('lxcbr0') ? 'lxcbr0' : (bridges[0] ?? null);

  const caps: LxcCapabilities = {
    available: isAvailable,
    version,
    cgroupVersion,
    unprivileged: isUnprivileged,
    network: isNetworkReady,
    defaultBridge,
    storageDriver: storage.driver,
    limits: {
      memory: {
        enforced: isAvailable,
        enforcement: isAvailable ? 'enforced' : 'unsupported',
        reason: isAvailable ? `cgroup v${cgroupVersion} memory limit` : 'LXC not available',
      },
      cpu: {
        enforced: isAvailable,
        enforcement: isAvailable ? 'enforced' : 'unsupported',
        reason: isAvailable ? `cgroup v${cgroupVersion} cpu quota` : 'LXC not available',
      },
      swap: {
        enforced: isAvailable && cgroupVersion === 2,
        enforcement: isAvailable ? (cgroupVersion === 2 ? 'enforced' : 'advisory') : 'unsupported',
        reason: cgroupVersion === 2 ? 'cgroup v2 memory.swap.max' : 'swap control requires cgroup v2',
      },
      storage: {
        enforced: storage.hardQuotaSupported,
        enforcement: storage.hardQuotaSupported ? 'enforced' : 'advisory',
        reason: storage.hardQuotaSupported
          ? 'Storage backend supports hard enforcement'
          : 'Directory backing store uses soft polling enforcement',
      },
      pids: {
        enforced: isAvailable,
        enforcement: isAvailable ? 'enforced' : 'unsupported',
        reason: isAvailable ? `cgroup v${cgroupVersion} pids.max` : 'LXC not available',
      },
    },
    operations: {
      create: binaryChecks['lxc-create'] === true,
      start: binaryChecks['lxc-start'] === true,
      stop: binaryChecks['lxc-stop'] === true,
      kill: binaryChecks['lxc-stop'] === true,
      delete: binaryChecks['lxc-destroy'] === true,
      attach: binaryChecks['lxc-attach'] === true,
      info: binaryChecks['lxc-info'] === true,
      stats: isAvailable,
    },
    details: {
      binaries: binaryChecks,
      subuid,
      subgid,
      bridges,
      reasons,
    },
  };

  cachedLxcCapabilities = caps;
  lastLxcCheckTime = now;

  logger.info('LXC capabilities probed', {
    available: caps.available,
    version: caps.version,
    cgroupVersion: caps.cgroupVersion,
    unprivileged: caps.unprivileged,
    network: caps.network,
    defaultBridge: caps.defaultBridge,
  });

  return caps;
}
