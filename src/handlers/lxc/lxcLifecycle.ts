import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import logger from '../../logger';
import { detectLxcCapabilities } from './lxcCapabilities';
import {
  getLxcConfigPath,
  getLxcContainerName,
  getLxcRootfsPath,
  updateLxcConfigFile,
} from './lxcConfig';
import { bootstrapLxcContainer } from './lxcBootstrap';

export interface CreateLxcOptions {
  id: string; // server UUID
  distribution: string; // e.g. ubuntu, debian, alpine
  release: string; // e.g. 24.04, 12, 3.20
  architecture?: string; // default amd64
  hostname?: string;
  memoryMb?: number;
  cpuQuota?: number;
  storageMb?: number;
  swapMb?: number;
  bridge?: string;
  ipv4?: string;
  gateway?: string;
  nameservers?: string[];
  sshAuthorizedKeys?: string[];
  unprivileged?: boolean;
}

export interface LxcContainerStatus {
  exists: boolean;
  running: boolean;
  status: string; // 'RUNNING' | 'STOPPED' | 'STARTING' | 'STOPPING' | 'UNKNOWN'
  pid: number | null;
  ip: string | null;
  source: 'lxc-info' | 'cgroup';
}

export interface LxcContainerStats {
  running: boolean;
  memory: {
    usage: number; // bytes
    limit: number; // bytes
    percentage: number;
  };
  cpu: {
    percentage: number;
    cores?: number;
  };
  network: {
    rx_bytes: number;
    tx_bytes: number;
  };
  pids?: number;
  uptime?: number;
}

// Memory cache of previous CPU stats to calculate real delta percentages
const cpuStatsCache = new Map<string, { lastTime: number; lastUsage: number }>();

/**
 * Creates a new LXC container using lxc-create with safe argument arrays
 */
export async function createLxcContainer(options: CreateLxcOptions): Promise<void> {
  const caps = await detectLxcCapabilities();
  if (!caps.available) {
    throw new Error('LXC is not installed or available on this node.');
  }

  const containerName = getLxcContainerName(options.id);
  const arch = options.architecture || 'amd64';
  const distro = options.distribution.toLowerCase().trim();
  const release = options.release.trim();

  logger.info(`Creating LXC container ${containerName} (${distro} ${release} ${arch})...`);

  const createArgs = [
    'lxc-create',
    '-n', containerName,
    '-t', 'download',
    '--',
    '-d', distro,
    '-r', release,
    '-a', arch,
  ];

  const proc = Bun.spawn(createArgs, {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    logger.error(`lxc-create failed for ${containerName}`, { stdout, stderr, exitCode });
    throw new Error(`Failed to create LXC container: ${stderr.trim() || stdout.trim() || `exit code ${exitCode}`}`);
  }

  // Update container configuration with network, cgroup limits, and metadata
  updateLxcConfigFile({
    id: options.id,
    containerName,
    hostname: options.hostname || containerName,
    memoryMb: options.memoryMb,
    cpuQuota: options.cpuQuota,
    storageMb: options.storageMb,
    swapMb: options.swapMb,
    bridge: options.bridge || caps.defaultBridge || 'lxcbr0',
    ipv4: options.ipv4,
    gateway: options.gateway,
    cgroupVersion: caps.cgroupVersion,
    unprivileged: options.unprivileged ?? true,
  });

  // Distro bootstrap (hostname, netplan/interfaces, ssh keys)
  await bootstrapLxcContainer({
    containerName,
    distribution: distro,
    hostname: options.hostname || containerName,
    ipv4: options.ipv4,
    gateway: options.gateway,
    nameservers: options.nameservers,
    sshAuthorizedKeys: options.sshAuthorizedKeys,
  });

  logger.info(`LXC container ${containerName} created and configured successfully.`);
}

/**
 * Starts an LXC container using lxc-start
 */
export async function startLxcContainer(id: string, configUpdates?: Partial<CreateLxcOptions>): Promise<void> {
  const containerName = getLxcContainerName(id);

  if (configUpdates) {
    const caps = await detectLxcCapabilities();
    updateLxcConfigFile({
      id,
      containerName,
      hostname: configUpdates.hostname,
      memoryMb: configUpdates.memoryMb,
      cpuQuota: configUpdates.cpuQuota,
      storageMb: configUpdates.storageMb,
      swapMb: configUpdates.swapMb,
      bridge: configUpdates.bridge || caps.defaultBridge || 'lxcbr0',
      ipv4: configUpdates.ipv4,
      gateway: configUpdates.gateway,
      cgroupVersion: caps.cgroupVersion,
    });
  }

  logger.info(`Starting LXC container ${containerName}...`);
  const proc = Bun.spawn(['lxc-start', '-n', containerName, '-d'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    logger.error(`lxc-start failed for ${containerName}`, { stderr, exitCode });
    throw new Error(`Failed to start LXC container: ${stderr.trim() || `exit code ${exitCode}`}`);
  }

  // Verify status
  const status = await getLxcContainerStatus(id);
  if (!status.running) {
    throw new Error(`LXC container ${containerName} failed to enter RUNNING state.`);
  }

  logger.info(`LXC container ${containerName} started successfully.`);
}

/**
 * Gracefully stops an LXC container using lxc-stop
 */
export async function stopLxcContainer(id: string, timeout = 15): Promise<void> {
  const containerName = getLxcContainerName(id);
  logger.info(`Stopping LXC container ${containerName} (timeout ${timeout}s)...`);

  const proc = Bun.spawn(['lxc-stop', '-n', containerName, '-t', String(timeout)], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    logger.warn(`lxc-stop warning/error for ${containerName}`, { stderr, exitCode });
  }

  logger.info(`LXC container ${containerName} stopped.`);
}

/**
 * Force kills an LXC container using lxc-stop -k
 */
export async function killLxcContainer(id: string): Promise<void> {
  const containerName = getLxcContainerName(id);
  logger.info(`Force-killing LXC container ${containerName}...`);

  const proc = Bun.spawn(['lxc-stop', '-n', containerName, '-k'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    logger.warn(`lxc-stop -k warning/error for ${containerName}`, { stderr, exitCode });
  }

  logger.info(`LXC container ${containerName} killed.`);
}

/**
 * Destroys an LXC container and its rootfs using lxc-destroy -f
 */
export async function deleteLxcContainer(id: string): Promise<void> {
  const containerName = getLxcContainerName(id);
  logger.info(`Destroying LXC container ${containerName}...`);

  const proc = Bun.spawn(['lxc-destroy', '-n', containerName, '-f'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    logger.warn(`lxc-destroy warning/error for ${containerName}`, { stderr, exitCode });
  }

  cpuStatsCache.delete(id);
  logger.info(`LXC container ${containerName} destroyed.`);
}

/**
 * Queries the real LXC state using lxc-info
 */
export async function getLxcContainerStatus(id: string): Promise<LxcContainerStatus> {
  const containerName = getLxcContainerName(id);

  try {
    const proc = Bun.spawn(['lxc-info', '-n', containerName], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0 || !stdout) {
      return {
        exists: false,
        running: false,
        status: 'STOPPED',
        pid: null,
        ip: null,
        source: 'lxc-info',
      };
    }

    let state = 'STOPPED';
    let pid: number | null = null;
    let ip: string | null = null;

    const lines = stdout.split('\n');
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length >= 2) {
        const key = parts[0].trim().toLowerCase();
        const value = parts.slice(1).join(':').trim();
        if (key === 'state') {
          state = value.toUpperCase();
        } else if (key === 'pid') {
          pid = parseInt(value, 10) || null;
        } else if (key === 'ip' && !ip) {
          ip = value.split(',')[0].trim();
        }
      }
    }

    const isRunning = state === 'RUNNING';

    return {
      exists: true,
      running: isRunning,
      status: state,
      pid,
      ip,
      source: 'lxc-info',
    };
  } catch (err) {
    logger.error(`Error querying lxc-info for ${containerName}:`, err);
    return {
      exists: false,
      running: false,
      status: 'UNKNOWN',
      pid: null,
      ip: null,
      source: 'lxc-info',
    };
  }
}

/**
 * Collects real resource usage from host cgroups for the container
 */
export async function getLxcContainerStats(id: string): Promise<LxcContainerStats | null> {
  const status = await getLxcContainerStatus(id);
  if (!status.exists || !status.running || !status.pid) {
    return {
      running: false,
      memory: { usage: 0, limit: 0, percentage: 0 },
      cpu: { percentage: 0 },
      network: { rx_bytes: 0, tx_bytes: 0 },
    };
  }

  const pid = status.pid;
  let memUsage = 0;
  let memLimit = 0;
  let cpuUsageUsec = 0;
  let rxBytes = 0;
  let txBytes = 0;

  // 1. Read cgroup v2/v1 memory
  try {
    const cgroup2MemCurrent = `/sys/fs/cgroup/lxc.payload.${getLxcContainerName(id)}/memory.current`;
    const cgroup2MemMax = `/sys/fs/cgroup/lxc.payload.${getLxcContainerName(id)}/memory.max`;
    if (existsSync(cgroup2MemCurrent)) {
      memUsage = parseInt(readFileSync(cgroup2MemCurrent, 'utf8').trim(), 10) || 0;
      if (existsSync(cgroup2MemMax)) {
        const rawMax = readFileSync(cgroup2MemMax, 'utf8').trim();
        memLimit = rawMax === 'max' ? 0 : parseInt(rawMax, 10) || 0;
      }
    } else {
      // Process status fallback
      const procStatm = `/proc/${pid}/statm`;
      if (existsSync(procStatm)) {
        const parts = readFileSync(procStatm, 'utf8').trim().split(/\s+/);
        const rssPages = parseInt(parts[1], 10) || 0;
        memUsage = rssPages * 4096;
      }
    }
  } catch {}

  // 2. Read CPU stats
  const now = Date.now();
  let cpuPercentage = 0;
  try {
    const cgroup2CpuStat = `/sys/fs/cgroup/lxc.payload.${getLxcContainerName(id)}/cpu.stat`;
    if (existsSync(cgroup2CpuStat)) {
      const lines = readFileSync(cgroup2CpuStat, 'utf8').split('\n');
      for (const l of lines) {
        if (l.startsWith('usage_usec')) {
          cpuUsageUsec = parseInt(l.split(/\s+/)[1], 10) || 0;
          break;
        }
      }

      const cached = cpuStatsCache.get(id);
      if (cached && now > cached.lastTime) {
        const deltaUsec = cpuUsageUsec - cached.lastUsage;
        const deltaMs = now - cached.lastTime;
        cpuPercentage = Math.max(0, Math.min(1000, Math.round((deltaUsec / (deltaMs * 1000)) * 100)));
      }
      cpuStatsCache.set(id, { lastTime: now, lastUsage: cpuUsageUsec });
    }
  } catch {}

  // 3. Read network stats from container netns
  try {
    const procNetDev = `/proc/${pid}/net/dev`;
    if (existsSync(procNetDev)) {
      const lines = readFileSync(procNetDev, 'utf8').split('\n');
      for (const line of lines) {
        if (line.includes('eth0:')) {
          const parts = line.split(':')[1].trim().split(/\s+/);
          rxBytes = parseInt(parts[0], 10) || 0;
          txBytes = parseInt(parts[8], 10) || 0;
          break;
        }
      }
    }
  } catch {}

  const memPercentage = memLimit > 0 ? Math.min(100, Math.round((memUsage / memLimit) * 100)) : 0;

  return {
    running: true,
    memory: {
      usage: memUsage,
      limit: memLimit,
      percentage: memPercentage,
    },
    cpu: {
      percentage: cpuPercentage,
    },
    network: {
      rx_bytes: rxBytes,
      tx_bytes: txBytes,
    },
  };
}

/**
 * Executes a command inside the LXC container via lxc-attach safely
 */
export async function executeInLxcContainer(id: string, command: string): Promise<string> {
  const containerName = getLxcContainerName(id);

  const proc = Bun.spawn(['lxc-attach', '-n', containerName, '--', '/bin/sh', '-c', command], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`Command failed inside LXC container: ${stderr.trim() || stdout.trim() || `exit code ${exitCode}`}`);
  }

  return stdout;
}
