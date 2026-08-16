import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import logger from '../../logger';
import {
  getLxcConfigPath,
  getServerUuidFromLxcName,
} from './lxcConfig';
import { getLxcContainerStatus } from './lxcLifecycle';

export interface DiscoveredLxcServer {
  id: string; // server UUID
  containerName: string;
  managed: boolean;
  running: boolean;
  status: string;
  pid: number | null;
  ip: string | null;
}

const managedLxcServers = new Map<string, DiscoveredLxcServer>();

/**
 * Checks if an LXC container is managed by Hyperodactyl
 */
export function isLxcContainerManaged(containerName: string): boolean {
  if (!containerName.startsWith('hx-')) return false;

  const configPath = getLxcConfigPath(containerName);
  if (!existsSync(configPath)) return false;

  try {
    const content = readFileSync(configPath, 'utf8');
    return content.includes('HYPERODACTYL_MANAGED') || content.includes('HYPERODACTYL_SERVER_UUID') || containerName.startsWith('hx-');
  } catch {
    return false;
  }
}

/**
 * Checks if a given ID is a registered or existing LXC container
 */
export function isLxcContainer(id: string): boolean {
  if (managedLxcServers.has(id)) return true;
  const containerName = `hx-${id.replace(/[^a-zA-Z0-9-]/g, '')}`;
  const configPath = getLxcConfigPath(containerName);
  return existsSync(configPath);
}

/**
 * Discovers all LXC containers on daemon boot and recovers their state
 */
export async function discoverLxcContainers(): Promise<DiscoveredLxcServer[]> {
  const lxcBaseDir = '/var/lib/lxc';
  if (!existsSync(lxcBaseDir)) {
    return [];
  }

  const discovered: DiscoveredLxcServer[] = [];

  try {
    const entries = readdirSync(lxcBaseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (!name.startsWith('hx-')) continue;

      const serverUuid = getServerUuidFromLxcName(name);
      if (!serverUuid) continue;

      const managed = isLxcContainerManaged(name);
      const status = await getLxcContainerStatus(serverUuid);

      const record: DiscoveredLxcServer = {
        id: serverUuid,
        containerName: name,
        managed,
        running: status.running,
        status: status.status,
        pid: status.pid,
        ip: status.ip,
      };

      managedLxcServers.set(serverUuid, record);
      discovered.push(record);

      logger.info('Discovered LXC container on startup', {
        serverUuid,
        containerName: name,
        running: status.running,
        status: status.status,
        ip: status.ip,
      });
    }
  } catch (err) {
    logger.warn('Error during LXC startup discovery:', err);
  }

  return discovered;
}

export function getManagedLxcServers(): Map<string, DiscoveredLxcServer> {
  return managedLxcServers;
}
