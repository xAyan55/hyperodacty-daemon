import type { ServerWebSocket } from 'bun';
import { docker } from '../handlers/docker';
import { appendRawLogChunk, isCapturing } from '../handlers/logHistory';
import { isLxcContainer } from '../handlers/lxc/lxcDiscovery';
import { getLxcContainerName } from '../handlers/lxc/lxcConfig';
import logger from '../logger';
import type { WsData } from './server';

export async function attachToContainer(id: string, ws: ServerWebSocket<WsData>): Promise<void> {
  if (isLxcContainer(id)) {
    try {
      const containerName = getLxcContainerName(id);
      const proc = Bun.spawn(['lxc-attach', '-n', containerName, '--', 'journalctl', '-f', '-n', '100'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const reader = proc.stdout.getReader();
      let active = true;

      (async () => {
        try {
          while (active) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              appendRawLogChunk(id, Buffer.from(value));
              if (ws.readyState === 1) ws.send(value);
            }
          }
        } catch {}
      })();

      ws.data._logCleanup = () => {
        active = false;
        try {
          proc.kill();
        } catch {}
      };
      return;
    } catch {
      if (ws.readyState === 1) ws.close(1000, 'container not available');
      return;
    }
  }

  try {
    const container = docker.getContainer(id);

    // container was created with Tty:true so docker sends a raw stream, no mux header
    // tail:0 if background collector already captured recent lines, tail:100 otherwise
    const logStream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: isCapturing(id) ? 0 : 100,
    });

    logStream.on('data', (chunk: Buffer) => {
      appendRawLogChunk(id, chunk);
      if (ws.readyState === 1) ws.send(chunk);
    });

    logStream.on('error', (err: Error) => {
      logger.error(`log stream error for ${id}`, err);
    });

    logStream.on('end', () => {
      if (ws.readyState === 1) ws.close(1000, 'stream ended');
    });

    // destroy the log stream when the ws closes — same pattern as express
    // avoids dockerode log streams leaking when the panel disconnects
    ws.data._logCleanup = () => {
      try {
        (logStream as unknown as { destroy(): void }).destroy();
      } catch {}
    };
  } catch {
    // container doesn't exist yet or has stopped — close cleanly without sending
    // any text to the terminal (xterm would render it as container output)
    if (ws.readyState === 1) ws.close(1000, 'container not available');
  }
}
