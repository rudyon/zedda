import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as p from '@clack/prompts';
import * as config from '../core/config.js';
import { runSetup } from './setup.js';

vi.mock('@clack/prompts', () => {
  const logMock = {
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  };

  return {
    intro: vi.fn(),
    select: vi.fn(),
    text: vi.fn(),
    multiselect: vi.fn(),
    isCancel: vi.fn(() => false),
    cancel: vi.fn(),
    log: logMock,
    outro: vi.fn(),
  };
});

vi.mock('fs');
vi.mock('../core/config.js');

describe('setup command', () => {
  const mockHomeDir = '/home/mockuser/.zedda';
  let originalExit: typeof process.exit;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(config, 'resolveHomeDir').mockReturnValue(mockHomeDir);
    
    originalExit = process.exit;
    process.exit = vi.fn().mockImplementation(() => {
      throw new Error('process.exit called');
    }) as any;
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it('runs interactive setup for OpenRouter with Discord adapter successfully', async () => {
    // Mock user choices
    vi.mocked(p.select)
      .mockResolvedValueOnce('openrouter') // Provider
      .mockResolvedValueOnce('deepseek/deepseek-v4-flash'); // Model
    vi.mocked(p.text)
      .mockResolvedValueOnce('op-key-123') // LLM API Key
      .mockResolvedValueOnce('discord-token-abc') // Discord Token
      .mockResolvedValueOnce('12345, 67890') // Allowed Users
      .mockResolvedValueOnce('12345'); // Primary User
    vi.mocked(p.multiselect).mockResolvedValueOnce(['discord']); // Adapters

    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      // Mock source template exists, but destination PERSONA.md does not
      if (p.toString().includes('templates')) return true;
      return false;
    });
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync');
    const copySpy = vi.spyOn(fs, 'copyFileSync');

    await runSetup();

    expect(p.intro).toHaveBeenCalled();
    expect(mkdirSpy).toHaveBeenCalledWith(mockHomeDir, { recursive: true });
    
    // Config saved
    expect(config.saveConfig).toHaveBeenCalledWith({
      gateway: { port: 9332 },
      paths: { home: mockHomeDir },
      llm: { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' },
      adapters: {
        discord: {
          enabled: true,
          allowed_users: ['12345', '67890'],
          primary_user: '12345',
        },
      },
    });

    // Env saved
    expect(config.saveEnv).toHaveBeenCalledWith({
      OPENROUTER_API_KEY: 'op-key-123',
      DISCORD_BOT_TOKEN: 'discord-token-abc',
    });

    // Copy PERSONA.md
    expect(copySpy).toHaveBeenCalled();
    expect(p.outro).toHaveBeenCalled();
  });

  it('runs interactive setup for W&B Provider successfully and generates models.json', async () => {
    // Mock choices
    vi.mocked(p.select)
      .mockResolvedValueOnce('wandb') // Provider
      .mockResolvedValueOnce('zai-org/GLM-5.1'); // Model
    vi.mocked(p.text).mockResolvedValueOnce('wandb-key-xyz'); // API Key
    vi.mocked(p.multiselect).mockResolvedValueOnce([]); // No adapters

    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      // Destination PERSONA.md already exists
      if (p.toString().includes('PERSONA.md')) return true;
      return false;
    });
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    const copySpy = vi.spyOn(fs, 'copyFileSync');

    await runSetup();

    // Verify config saved
    expect(config.saveConfig).toHaveBeenCalledWith({
      gateway: { port: 9332 },
      paths: { home: mockHomeDir },
      llm: { provider: 'wandb', model: 'zai-org/GLM-5.1' },
      adapters: {
        discord: {
          enabled: false,
          allowed_users: [],
          primary_user: '',
        },
      },
    });

    // Verify W&B key is saved in env
    expect(config.saveEnv).toHaveBeenCalledWith({
      WANDB_API_KEY: 'wandb-key-xyz',
    });

    // Check custom models.json is generated
    expect(writeSpy).toHaveBeenCalledWith(
      path.join(mockHomeDir, 'models.json'),
      expect.stringContaining('zai-org/GLM-5.1'),
      'utf8'
    );

    // PERSONA.md exists, so copyFileSync should NOT be called (non-destructive)
    expect(copySpy).not.toHaveBeenCalled();
    expect(p.log.info).toHaveBeenCalledWith(expect.stringContaining('PERSONA.md already exists'));
  });

  it('cancels wizard and exits process when user cancels a prompt', async () => {
    vi.mocked(p.select).mockResolvedValueOnce('openrouter');
    vi.mocked(p.isCancel).mockReturnValue(true); // Simulate cancellation

    await expect(runSetup()).rejects.toThrow('process.exit called');

    expect(p.cancel).toHaveBeenCalledWith('Setup cancelled.');
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
