import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import logger from '../../logger';

export interface LxcConfigOptions {
  id: string; // server UUID
  containerName: string; // hx-<uuid>
  hostname?: string;
  memoryMb?: number;
  swapMb?: number;
  cpuQuota?: number; // 100 = 1 core
  storageMb?: number;
  bridge?: string;
  ipv4?: string;
  gateway?: string;
  cgroupVersion?: number;
  unprivileged?: boolean;
}

/**
 * Returns deterministic LXC container name from Server UUID
 */
export function getLxcContainerName(uuid: string): string {
  const cleanUuid = uuid.replace(/[^a-zA-Z0-9-]/g, '');
  return `hx-${cleanUuid}`;
}

/**
 * Extracts Server UUID from deterministic LXC container name
 */
export function getServerUuidFromLxcName(containerName: string): string | null {
  if (containerName.startsWith('hx-')) {
    return containerName.slice(3);
  }
  return null;
}

/**
 * Returns container config file path
 */
export function getLxcConfigPath(containerName: string): string {
  return join('/var/lib/lxc', containerName, 'config');
}

/**
 * Returns container rootfs path
 */
export function getLxcRootfsPath(containerName: string): string {
  return join('/var/lib/lxc', containerName, 'rootfs');
}

/**
 * Generates and writes container configuration updates for resource limits, networking, and metadata
 */
export function updateLxcConfigFile(options: LxcConfigOptions): void {
  const configPath = getLxcConfigPath(options.containerName);
  if (!existsSync(configPath)) {
    logger.warn(`LXC config file not found at ${configPath}`);
    return;
  }

  let existing = readFileSync(configPath, 'utf8');

  // Strip previously appended hyperodactyl configuration block if any
  const markerStart = '# --- BEGIN HYPERODACTYL MANAGED CONFIG ---';
  const markerEnd = '# --- END HYPERODACTYL MANAGED CONFIG ---';
  const startIndex = existing.indexOf(markerStart);
  const endIndex = existing.indexOf(markerEnd);

  if (startIndex !== -1 && endIndex !== -1) {
    existing = existing.slice(0, startIndex) + existing.slice(endIndex + markerEnd.length);
  }

  const lines: string[] = [
    '',
    markerStart,
    `# Managed by Hyperodactyl Daemon`,
    `# Server UUID: ${options.id}`,
    `lxc.environment.HYPERODACTYL_MANAGED = 1`,
    `lxc.environment.HYPERODACTYL_SERVER_UUID = ${options.id}`,
  ];

  // Hostname
  if (options.hostname) {
    lines.push(`lxc.uts.name = ${options.hostname}`);
  }

  // Networking
  const bridge = options.bridge || 'lxcbr0';
  lines.push(`lxc.net.0.type = veth`);
  lines.push(`lxc.net.0.flags = up`);
  lines.push(`lxc.net.0.link = ${bridge}`);
  lines.push(`lxc.net.0.name = eth0`);

  if (options.ipv4) {
    // If netmask not provided, default /24 or /32
    const ipWithCidr = options.ipv4.includes('/') ? options.ipv4 : `${options.ipv4}/24`;
    lines.push(`lxc.net.0.ipv4.address = ${ipWithCidr}`);
  }

  if (options.gateway) {
    lines.push(`lxc.net.0.ipv4.gateway = ${options.gateway}`);
  }

  // Resource limits (cgroup v2 vs v1)
  const isV2 = (options.cgroupVersion ?? 2) === 2;

  // Memory limits
  if (options.memoryMb && options.memoryMb > 0) {
    const memoryBytes = options.memoryMb * 1024 * 1024;
    if (isV2) {
      lines.push(`lxc.cgroup2.memory.max = ${memoryBytes}`);
      if (options.swapMb !== undefined && options.swapMb >= 0) {
        const swapBytes = options.swapMb * 1024 * 1024;
        lines.push(`lxc.cgroup2.memory.swap.max = ${swapBytes}`);
      }
    } else {
      lines.push(`lxc.cgroup.memory.limit_in_bytes = ${memoryBytes}`);
      if (options.swapMb !== undefined && options.swapMb >= 0) {
        const memPlusSwap = (options.memoryMb + options.swapMb) * 1024 * 1024;
        lines.push(`lxc.cgroup.memory.memsw.limit_in_bytes = ${memPlusSwap}`);
      }
    }
  }

  // CPU limits (100 = 1 full core = 100000 quota with 100000 period)
  if (options.cpuQuota && options.cpuQuota > 0) {
    const period = 100000;
    const quota = Math.round((options.cpuQuota / 100) * period);
    if (isV2) {
      lines.push(`lxc.cgroup2.cpu.max = ${quota} ${period}`);
    } else {
      lines.push(`lxc.cgroup.cpu.cfs_period_us = ${period}`);
      lines.push(`lxc.cgroup.cpu.cfs_quota_us = ${quota}`);
    }
  }

  lines.push(markerEnd);
  lines.push('');

  writeFileSync(configPath, existing.trimEnd() + lines.join('\n'), 'utf8');
}
