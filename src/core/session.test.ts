import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getOrCreateSession, shutdownAllSessions } from './session.js';
import * as config from './config.js';

vi.mock('@earendil-works/pi-coding-agent', () => {
  const mockDispose = vi.fn(() => Promise.resolve());
  const mockBindExtensions = vi.fn(() => Promise.resolve());
  const mockSession = {
    dispose: mockDispose,
    bindExtensions: mockBindExtensions,
  };
  (globalThis as any).mockSession = mockSession;

  const mockSessionManager = {
    getSessionFile: vi.fn(() => '/home/mockuser/.zedda/sessions/session-1.jsonl'),
  };

  return {
    SessionManager: {
      open: vi.fn(() => mockSessionManager),
      create: vi.fn(() => mockSessionManager),
    },
    createAgentSession: vi.fn(() => Promise.resolve({ session: mockSession })),
    DefaultResourceLoader: vi.fn(function(opts: any) {
      (globalThis as any).lastSystemPromptOverride = opts.systemPromptOverride;
    }),
    getAgentDir: vi.fn(() => '/home/mockuser/.zedda'),
  };
});

vi.mock('fs');
vi.mock('./config.js');

describe('session', () => {
  const mockHomeDir = '/home/mockuser/.zedda';
  let mockSessionObj: any;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    (globalThis as any).lastSystemPromptOverride = null;

    vi.spyOn(config, 'resolveHomeDir').mockReturnValue(mockHomeDir);
    vi.spyOn(config, 'loadConfig').mockReturnValue({
      llm: {
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash',
      },
    });

    mockSessionObj = (globalThis as any).mockSession;
    mockSessionObj.dispose.mockClear();
    mockSessionObj.bindExtensions.mockClear();

    // Clean up activeSessions map in core/session.ts before each test
    await shutdownAllSessions();
    mockSessionObj.dispose.mockClear(); // Clear dispose calls made during shutdownAllSessions cleanup
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a new session if one does not exist', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync');
    const writeSpy = vi.spyOn(fs, 'writeFileSync');

    const session = await getOrCreateSession('channel-1');

    expect(session).toBe(mockSessionObj);
    expect(mkdirSpy).toHaveBeenCalledWith(path.join(mockHomeDir, 'sessions'), { recursive: true });
    expect(writeSpy).toHaveBeenCalledWith(
      path.join(mockHomeDir, 'sessions_mapping.json'),
      expect.stringContaining('channel-1'),
      'utf8'
    );
    expect(mockSessionObj.bindExtensions).toHaveBeenCalled();
  });

  it('re-hydrates session if mapping file contains it and file exists', async () => {
    const sessionFile = path.join(mockHomeDir, 'sessions/session-1.jsonl');
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      if (p === path.join(mockHomeDir, 'sessions_mapping.json')) return true;
      if (p === sessionFile) return true;
      return false;
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (p === path.join(mockHomeDir, 'sessions_mapping.json')) {
        return JSON.stringify({ 'channel-1': sessionFile });
      }
      return '';
    });

    const session = await getOrCreateSession('channel-1');
    expect(session).toBe(mockSessionObj);
  });

  it('compiles prompt system with default prompt and PERSONA.md when PERSONA.md exists', async () => {
    const personaPath = path.join(mockHomeDir, 'PERSONA.md');
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === personaPath);
    vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (p === personaPath) return 'User Persona Details';
      return '';
    });

    await getOrCreateSession('channel-2');

    const systemPromptOverride = (globalThis as any).lastSystemPromptOverride;
    expect(systemPromptOverride).toBeTypeOf('function');

    const result = systemPromptOverride('Base System Prompt');
    expect(result).toBe('Base System Prompt\n\nUser Persona Details');
  });

  it('falls back to default prompt if PERSONA.md is missing', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    await getOrCreateSession('channel-3');

    const systemPromptOverride = (globalThis as any).lastSystemPromptOverride;
    expect(systemPromptOverride).toBeTypeOf('function');
    
    const result = systemPromptOverride('Base System Prompt');
    expect(result).toBe('Base System Prompt');
  });

  it('evicts session after 1 hour of inactivity', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    await getOrCreateSession('channel-evict');
    expect(mockSessionObj.dispose).not.toHaveBeenCalled();

    // Advance time by 59 minutes (no eviction yet)
    vi.advanceTimersByTime(59 * 60 * 1000);
    expect(mockSessionObj.dispose).not.toHaveBeenCalled();

    // Advance time by another 2 minutes (exceeds 1 hour limit)
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(mockSessionObj.dispose).toHaveBeenCalled();
  });

  it('resets inactivity timer on getOrCreateSession call', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    await getOrCreateSession('channel-reset');

    // Advance 30 minutes
    vi.advanceTimersByTime(30 * 60 * 1000);

    // Call getOrCreateSession again, resetting the timer
    await getOrCreateSession('channel-reset');

    // Advance another 45 minutes (total 75 minutes from start, but only 45 minutes from reset)
    vi.advanceTimersByTime(45 * 60 * 1000);
    expect(mockSessionObj.dispose).not.toHaveBeenCalled();

    // Advance another 20 minutes (now exceeds 1 hour from reset)
    vi.advanceTimersByTime(20 * 60 * 1000);
    expect(mockSessionObj.dispose).toHaveBeenCalled();
  });

  it('disposes all active sessions on shutdownAllSessions', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    await getOrCreateSession('channel-shutdown-1');
    await getOrCreateSession('channel-shutdown-2');

    mockSessionObj.dispose.mockClear();

    await shutdownAllSessions();

    expect(mockSessionObj.dispose).toHaveBeenCalledTimes(2);
  });
});
