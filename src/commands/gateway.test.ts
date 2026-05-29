import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import { WebSocket } from 'ws';
import * as child_process from 'child_process';
import * as config from '../core/config.js';
import * as session from '../core/session.js';
import * as discord from '../adapters/discord.js';
import { runGateway, restartGateway } from './gateway.js';

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock('../core/config.js');
vi.mock('../core/session.js');
vi.mock('../adapters/discord.js');

vi.mock('http', async (importOriginal) => {
  const originalHttp = await importOriginal<typeof import('http')>();
  return {
    ...originalHttp,
    createServer: vi.fn((...args: any[]) => {
      const server = originalHttp.createServer(...args);
      (globalThis as any).createdServer = server;
      return server;
    }),
  };
});

describe('gateway command', () => {
  let originalExit: typeof process.exit;
  let originalProcessOn: typeof process.on;
  let testPort = 19330;
  let rejectionsHandler: any;

  const waitListening = async () => {
    const server = (globalThis as any).createdServer;
    if (!server) return;
    if (server.listening) return;
    await new Promise<void>((resolve) => server.on('listening', () => resolve()));
  };

  beforeEach(() => {
    vi.resetAllMocks();
    (globalThis as any).createdServer = null;
    
    // Generate a random port between 20000 and 50000 to prevent collisions during parallel worker runs
    testPort = Math.floor(Math.random() * 30000) + 20000;

    originalExit = process.exit;
    process.exit = vi.fn().mockImplementation(() => {
      throw new Error('process.exit called');
    }) as any;

    originalProcessOn = process.on;
    process.on = vi.fn() as any;

    // Handle unhandled rejections from process.exit mock throwing in async handlers
    rejectionsHandler = (reason: any) => {
      if (reason && reason.message === 'process.exit called') {
        return;
      }
    };
    process.addListener('unhandledRejection', rejectionsHandler);

    vi.spyOn(config, 'loadConfig').mockReturnValue({
      gateway: { port: testPort },
    });

    vi.spyOn(discord, 'startDiscordBot').mockResolvedValue(undefined as any);
    vi.spyOn(discord, 'stopDiscordBot').mockResolvedValue(undefined as any);
    vi.spyOn(session, 'shutdownAllSessions').mockResolvedValue(undefined as any);
  });

  afterEach(async () => {
    process.exit = originalExit;
    process.on = originalProcessOn;
    process.removeListener('unhandledRejection', rejectionsHandler);

    const server = (globalThis as any).createdServer;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      (globalThis as any).createdServer = null;
    }
  });

  it('handles EADDRINUSE error and exits with 1', async () => {
    await runGateway();

    const server = (globalThis as any).createdServer;
    expect(server).not.toBeNull();
    
    expect(() => {
      server.emit('error', { code: 'EADDRINUSE' });
    }).toThrow('process.exit called');

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('serves /health endpoint successfully', async () => {
    await runGateway();
    await waitListening();

    const responseData = await new Promise<string>((resolve) => {
      http.get(`http://127.0.0.1:${testPort}/health`, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      });
    });

    const parsed = JSON.parse(responseData);
    expect(parsed).toEqual({ status: 'ok', service: 'zedda-gateway' });
  });

  it('handles /restart endpoint by shutting down resources and spawning a new process', async () => {
    await runGateway();
    await waitListening();

    // Trigger restart
    try {
      await restartGateway();
    } catch (err) {
      // Ignored
    }

    // Wait a brief moment for the async handler to execute all cleanup
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(discord.stopDiscordBot).toHaveBeenCalled();
    expect(session.shutdownAllSessions).toHaveBeenCalled();
    expect(child_process.spawn).toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('restarts gateway using restartGateway utility function when server is mocked', async () => {
    // Mock the HTTP server to respond with 200 OK to the restart request
    const mockServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/restart') {
        res.writeHead(200);
        res.end();
      }
    });

    await new Promise<void>((resolve) => mockServer.listen(testPort, '127.0.0.1', resolve));

    await expect(restartGateway()).resolves.toBeUndefined();

    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });
});
