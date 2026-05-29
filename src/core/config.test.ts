import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { expandTilde, getBootstrapConfigPath, resolveHomeDir, loadConfig, saveConfig, loadEnv, saveEnv } from './config.js';

vi.mock('fs');
vi.mock('os');

describe('config', () => {
  const mockHomeDir = '/home/mockuser';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(os, 'homedir').mockReturnValue(mockHomeDir);
  });

  describe('expandTilde', () => {
    it('expands tilde to home directory', () => {
      const result = expandTilde('~/some/path');
      expect(result).toBe(path.join(mockHomeDir, 'some/path'));
    });

    it('returns path untouched if it does not start with tilde', () => {
      const result = expandTilde('/absolute/path');
      expect(result).toBe('/absolute/path');
    });
  });

  describe('getBootstrapConfigPath', () => {
    it('returns the correct default bootstrap config path', () => {
      const result = getBootstrapConfigPath();
      expect(result).toBe(path.join(mockHomeDir, '.zedda', 'config.toml'));
    });
  });

  describe('resolveHomeDir', () => {
    it('returns default home directory if bootstrap config does not exist', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      const result = resolveHomeDir();
      expect(result).toBe(path.join(mockHomeDir, '.zedda'));
    });

    it('returns custom home directory from bootstrap config if it exists', () => {
      const bootstrapConfigPath = path.join(mockHomeDir, '.zedda', 'config.toml');
      vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === bootstrapConfigPath);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(`
[paths]
home = "~/custom-zedda-home"
      `);

      const result = resolveHomeDir();
      expect(result).toBe(path.resolve(path.join(mockHomeDir, 'custom-zedda-home')));
    });

    it('falls back to default if parsing bootstrap config fails', () => {
      const bootstrapConfigPath = path.join(mockHomeDir, '.zedda', 'config.toml');
      vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === bootstrapConfigPath);
      vi.spyOn(fs, 'readFileSync').mockReturnValue('invalid toml syntax');
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = resolveHomeDir();
      expect(result).toBe(path.join(mockHomeDir, '.zedda'));
      expect(consoleWarnSpy).toHaveBeenCalled();
    });
  });

  describe('loadConfig', () => {
    it('returns empty config object if config file does not exist', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      const config = loadConfig();
      expect(config).toEqual({});
    });

    it('parses and returns config from file if it exists', () => {
      const expectedHome = path.join(mockHomeDir, '.zedda');
      const configPath = path.join(expectedHome, 'config.toml');
      
      vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === configPath || p === path.join(expectedHome, 'config.toml'));
      vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
        if (p === configPath) {
          return `
[gateway]
port = 9999
[llm]
provider = "openrouter"
model = "deepseek/deepseek-v4-flash"
`;
        }
        return '';
      });

      const config = loadConfig();
      expect(config).toEqual({
        gateway: { port: 9999 },
        llm: { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' }
      });
    });
  });

  describe('saveConfig', () => {
    it('creates directories and writes to config file', () => {
      const expectedHome = path.join(mockHomeDir, '.zedda');
      const configPath = path.join(expectedHome, 'config.toml');
      
      const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync');
      const writeSpy = vi.spyOn(fs, 'writeFileSync');

      const config = {
        gateway: { port: 1234 },
        paths: { home: '~/custom' }
      };

      saveConfig(config);

      expect(existsSpy).toHaveBeenCalledWith(expectedHome);
      expect(mkdirSpy).toHaveBeenCalledWith(expectedHome, { recursive: true });
      expect(writeSpy).toHaveBeenCalledWith(configPath, expect.stringContaining('port = 1234'), 'utf8');
    });
  });

  describe('loadEnv', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('loads env variables and populates process.env', () => {
      const expectedHome = path.join(mockHomeDir, '.zedda');
      const envPath = path.join(expectedHome, '.env');

      vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === envPath);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(`
TEST_API_KEY=my-secret-key
ANOTHER_VAL=123
`);

      const result = loadEnv();
      expect(result).toEqual({
        TEST_API_KEY: 'my-secret-key',
        ANOTHER_VAL: '123'
      });
      expect(process.env.TEST_API_KEY).toBe('my-secret-key');
      expect(process.env.ANOTHER_VAL).toBe('123');
    });
  });

  describe('saveEnv', () => {
    it('creates home dir if needed and writes env variables', () => {
      const expectedHome = path.join(mockHomeDir, '.zedda');
      const envPath = path.join(expectedHome, '.env');

      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync');
      const writeSpy = vi.spyOn(fs, 'writeFileSync');

      saveEnv({
        MY_KEY: 'my_val',
        OTHER: 'other_val'
      });

      expect(mkdirSpy).toHaveBeenCalledWith(expectedHome, { recursive: true });
      expect(writeSpy).toHaveBeenCalledWith(envPath, 'MY_KEY=my_val\nOTHER=other_val\n', 'utf8');
    });
  });
});
