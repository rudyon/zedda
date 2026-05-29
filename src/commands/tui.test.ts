import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as child_process from 'child_process';
import { WebSocket } from 'ws';
import * as p from '@clack/prompts';
import * as config from '../core/config.js';
import { runTui } from './tui.js';

// Setup global mock holders
const mockWebSocketInstance = {
  on: vi.fn(),
  send: vi.fn(),
  close: vi.fn(),
};

vi.mock('ws', () => {
  return {
    WebSocket: vi.fn(function() {
      return mockWebSocketInstance;
    }),
  };
});

vi.mock('@clack/prompts', () => {
  return {
    intro: vi.fn(),
    confirm: vi.fn(),
    cancel: vi.fn(),
    isCancel: vi.fn(() => false),
  };
});

vi.mock('child_process', () => {
  const mockProcess = {
    on: vi.fn(),
    kill: vi.fn(),
    killed: false,
  };
  return {
    spawn: vi.fn(() => mockProcess),
  };
});

vi.mock('http');
vi.mock('../core/config.js');

vi.mock('@earendil-works/pi-coding-agent', () => {
  const mockSession = {
    prompt: vi.fn(),
    abort: vi.fn(),
    navigateTree: vi.fn(),
    setModel: vi.fn(),
    setThinkingLevel: vi.fn(),
    _emit: vi.fn(),
  };

  const mockRuntime = {
    session: mockSession,
    dispose: vi.fn(() => Promise.resolve()),
  };

  const mockSessionManager = {
    newSession: vi.fn(),
    fileEntries: [],
    _buildIndex: vi.fn(),
  };

  const mockModelRegistry = {
    find: vi.fn(() => ({ provider: 'openrouter', id: 'deepseek/deepseek-v4-flash' })),
  };

  const mockServices = {
    modelRegistry: mockModelRegistry,
  };

  return {
    InteractiveMode: vi.fn(function() {
      return {
        run: vi.fn(() => Promise.resolve())
      };
    }),
    SessionManager: {
      inMemory: vi.fn(() => mockSessionManager),
    },
    createAgentSessionServices: vi.fn(() => Promise.resolve(mockServices)),
    createAgentSessionFromServices: vi.fn(() => Promise.resolve({ session: mockSession })),
    createAgentSessionRuntime: vi.fn((cb: any) => cb({
      cwd: '',
      agentDir: '',
      sessionManager: mockSessionManager,
    }).then(() => mockRuntime)),
  };
});

describe('tui command', () => {
  const mockHomeDir = '/home/mockuser/.zedda';
  let originalExit: typeof process.exit;
  let originalProcessOn: typeof process.on;
  let processListeners: any[] = [];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();

    originalExit = process.exit;
    process.exit = vi.fn().mockImplementation(() => {
      throw new Error('process.exit called');
    }) as any;

    originalProcessOn = process.on;
    processListeners = [];
    process.on = vi.fn((event, cb) => {
      processListeners.push({ event, cb });
      return process;
    }) as any;

    vi.spyOn(config, 'resolveHomeDir').mockReturnValue(mockHomeDir);
    vi.spyOn(config, 'loadConfig').mockReturnValue({
      gateway: { port: 9332 },
    });

    mockWebSocketInstance.on.mockClear();
    mockWebSocketInstance.send.mockClear();
    mockWebSocketInstance.close.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    process.exit = originalExit;
    process.on = originalProcessOn;
  });

  it('connects to gateway immediately if health check is successful', async () => {
    // 1. Mock health check HTTP success (statusCode 200)
    vi.spyOn(http, 'get').mockImplementation((url, cb: any) => {
      const mockRes = { statusCode: 200 };
      cb(mockRes);
      return { on: vi.fn(), end: vi.fn() } as any;
    });

    // 2. Mock WebSocket message callbacks to simulate init handshake and connection
    mockWebSocketInstance.on.mockImplementation((event, cb) => {
      if (event === 'open') {
        // ws open
        setTimeout(() => cb(), 10);
      }
      if (event === 'message') {
        // init frame
        const initFrame = JSON.stringify({
          type: 'init',
          header: { id: 'session-tui-123' },
          entries: [],
          model: { provider: 'openrouter', id: 'deepseek/deepseek-v4-flash' },
        });
        setTimeout(() => cb(Buffer.from(initFrame)), 20);
      }
    });

    const promise = runTui();

    // Advance fake timers to execute callbacks
    await vi.advanceTimersByTimeAsync(100);

    await promise;

    expect(http.get).toHaveBeenCalledWith('http://127.0.0.1:9332/health', expect.any(Function));
    expect(p.confirm).not.toHaveBeenCalled();
    expect(child_process.spawn).not.toHaveBeenCalled();
    expect(mockWebSocketInstance.close).toHaveBeenCalled(); // handshake closed
  });

  it('prompts and spawns gateway if health check fails and user approves', async () => {
    // 1. Mock health check to fail initially (synchronously), then succeed on second attempt
    let getCallCount = 0;
    vi.spyOn(http, 'get').mockImplementation((url, cb: any) => {
      getCallCount++;
      if (getCallCount === 1) {
        // First ping fails (no gateway running)
        const req = { on: vi.fn((event, errCb) => {
          if (event === 'error') {
            errCb(new Error('Connection refused'));
          }
        }), end: vi.fn() };
        return req as any;
      } else {
        // Subsequent pings succeed (gateway spawned)
        cb({ statusCode: 200 });
        return { on: vi.fn(), end: vi.fn() } as any;
      }
    });

    // Mock confirm dialog to say yes
    vi.mocked(p.confirm).mockResolvedValueOnce(true);

    // Mock WS events for connection
    mockWebSocketInstance.on.mockImplementation((event, cb) => {
      if (event === 'open') {
        setTimeout(() => cb(), 10);
      }
      if (event === 'message') {
        const initFrame = JSON.stringify({
          type: 'init',
          header: { id: 'session-tui-456' },
        });
        setTimeout(() => cb(Buffer.from(initFrame)), 20);
      }
    });

    const promise = runTui();

    // Run confirm prompt
    await vi.advanceTimersByTimeAsync(10);
    // Spawns daemon and starts check loop. We retry every 1000ms.
    // Loop will see health success on second get call.
    await vi.advanceTimersByTimeAsync(1100);
    
    await promise;

    expect(p.confirm).toHaveBeenCalled();
    expect(child_process.spawn).toHaveBeenCalled();
    expect(getCallCount).toBe(2);
  });

  it('aborts TUI mode if gateway not running and user denies start prompt', async () => {
    vi.spyOn(http, 'get').mockImplementation((url, cb) => {
      const req = { on: vi.fn((event, errCb) => {
        if (event === 'error') {
          errCb(new Error('Connection refused'));
        }
      }), end: vi.fn() };
      return req as any;
    });

    // User says no
    vi.mocked(p.confirm).mockResolvedValueOnce(false);

    await expect(runTui()).rejects.toThrow('process.exit called');

    expect(p.cancel).toHaveBeenCalledWith(expect.stringContaining('TUI mode aborted'));
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(child_process.spawn).not.toHaveBeenCalled();
  });
});
