import logger from '../logger';
import {
  deleteContainerAndVolume,
  getContainerStats,
  isContainerRunning,
  killContainer,
  sendCommandToContainer,
  startContainer,
  stopContainer,
  docker,
} from './docker';
import { isLxcContainer } from './lxc/lxcDiscovery';
import {
  createLxcContainer,
  deleteLxcContainer,
  executeInLxcContainer,
  getLxcContainerStats,
  getLxcContainerStatus,
  killLxcContainer,
  startLxcContainer,
  stopLxcContainer,
  type CreateLxcOptions,
} from './lxc/lxcLifecycle';

export type WorkloadType = 'docker' | 'lxc';

/**
 * Resolves the workload runtime type for a given container ID and optional explicit hint
 */
export function resolveWorkloadType(id: string, explicitType?: string): WorkloadType {
  if (explicitType === 'lxc') return 'lxc';
  if (explicitType === 'docker') return 'docker';
  if (isLxcContainer(id)) return 'lxc';
  return 'docker';
}

export const RuntimeResolver = {
  resolveWorkloadType,

  async start(
    id: string,
    options: {
      runtimeType?: string;
      image?: string;
      ports?: string;
      env?: Record<string, string>;
      Memory?: number;
      Cpu?: number;
      Storage?: number;
      Swap?: number;
      StartCommand?: string;
      mounts?: { source: string; target: string; readOnly?: boolean }[];
      lxcConfig?: Partial<CreateLxcOptions>;
    },
  ): Promise<void> {
    const runtime = resolveWorkloadType(id, options.runtimeType);

    if (runtime === 'lxc') {
      await startLxcContainer(id, {
        memoryMb: options.Memory,
        cpuQuota: options.Cpu,
        storageMb: options.Storage,
        swapMb: options.Swap,
        ...options.lxcConfig,
      });
    } else {
      await startContainer(
        id,
        options.image || '',
        options.env || {},
        options.ports || '',
        options.Memory || 512,
        options.Cpu || 100,
        options.Storage || 0,
        options.Swap || 0,
        options.mounts || [],
      );
    }
  },

  async stop(id: string, stopCmd?: string, explicitRuntime?: string): Promise<void> {
    const runtime = resolveWorkloadType(id, explicitRuntime);
    if (runtime === 'lxc') {
      await stopLxcContainer(id, 15);
    } else {
      await stopContainer(id, stopCmd);
    }
  },

  async restart(id: string, stopCmd?: string, explicitRuntime?: string): Promise<void> {
    const runtime = resolveWorkloadType(id, explicitRuntime);
    if (runtime === 'lxc') {
      await stopLxcContainer(id, 10);
      await new Promise((r) => setTimeout(r, 1000));
      await startLxcContainer(id);
    } else {
      await stopContainer(id, stopCmd);
    }
  },

  async kill(id: string, explicitRuntime?: string): Promise<void> {
    const runtime = resolveWorkloadType(id, explicitRuntime);
    if (runtime === 'lxc') {
      await killLxcContainer(id);
    } else {
      await killContainer(id);
    }
  },

  async delete(id: string, explicitRuntime?: string): Promise<void> {
    const runtime = resolveWorkloadType(id, explicitRuntime);
    if (runtime === 'lxc') {
      await deleteLxcContainer(id);
    } else {
      await deleteContainerAndVolume(id);
    }
  },

  async getStatus(id: string, explicitRuntime?: string): Promise<{
    running: boolean;
    exists: boolean;
    status?: string;
    exitCode?: number | null;
    startedAt?: string;
    source?: string;
    ip?: string | null;
    runtimeType: WorkloadType;
  }> {
    const runtime = resolveWorkloadType(id, explicitRuntime);

    if (runtime === 'lxc') {
      const lxcStatus = await getLxcContainerStatus(id);
      return {
        running: lxcStatus.running,
        exists: lxcStatus.exists,
        status: lxcStatus.status,
        exitCode: lxcStatus.running ? null : 0,
        source: lxcStatus.source,
        ip: lxcStatus.ip,
        runtimeType: 'lxc',
      };
    }

    const knownRunning = isContainerRunning(id);
    if (knownRunning !== null) {
      return { running: knownRunning, exists: true, source: 'cache', runtimeType: 'docker' };
    }

    const info = await docker
      .getContainer(id)
      .inspect()
      .catch(() => null);

    if (!info) return { running: false, exists: false, runtimeType: 'docker' };

    return {
      running: info.State.Running,
      exists: true,
      status: info.State.Status,
      exitCode: typeof info.State.ExitCode === 'number' ? info.State.ExitCode : null,
      startedAt: info.State.StartedAt,
      source: 'inspect',
      runtimeType: 'docker',
    };
  },

  async getStats(id: string, explicitRuntime?: string): Promise<unknown> {
    const runtime = resolveWorkloadType(id, explicitRuntime);
    if (runtime === 'lxc') {
      return await getLxcContainerStats(id);
    }
    return await getContainerStats(id);
  },

  async sendCommand(id: string, command: string, explicitRuntime?: string): Promise<void> {
    const runtime = resolveWorkloadType(id, explicitRuntime);
    if (runtime === 'lxc') {
      await executeInLxcContainer(id, command);
    } else {
      await sendCommandToContainer(id, command);
    }
  },
};
