import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as toml from 'smol-toml';
import * as dotenv from 'dotenv';

export interface GatewayConfig {
  port: number;
}

export interface PathsConfig {
  home: string;
}

export interface LlmConfig {
  provider: string;
  model: string;
}

export interface DiscordConfig {
  enabled: boolean;
  allowed_users: string[];
  primary_user: string;
}

export interface AppConfig {
  gateway?: GatewayConfig;
  paths?: PathsConfig;
  llm?: LlmConfig;
  adapters?: {
    discord?: DiscordConfig;
  };
}

// Expands the tilde `~` symbol at the beginning of a path to the user's home directory.
export function expandTilde(filepath: string): string {
  if (filepath.startsWith('~')) {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

// Gets the default bootstrap path for the config: ~/.zedda/config.toml
export function getBootstrapConfigPath(): string {
  return path.join(os.homedir(), '.zedda', 'config.toml');
}

// Resolves the final home directory path
export function resolveHomeDir(): string {
  const defaultHome = path.join(os.homedir(), '.zedda');
  const bootstrapConfigPath = path.join(defaultHome, 'config.toml');

  if (fs.existsSync(bootstrapConfigPath)) {
    try {
      const content = fs.readFileSync(bootstrapConfigPath, 'utf8');
      const parsed = toml.parse(content) as AppConfig;
      if (parsed.paths?.home) {
        return path.resolve(expandTilde(parsed.paths.home));
      }
    } catch (err) {
      console.warn('Warning: Failed to parse bootstrap config.toml:', err);
    }
  }
  return defaultHome;
}

// Loads the configuration file from the resolved home directory
export function loadConfig(): AppConfig {
  const homeDir = resolveHomeDir();
  const configPath = path.join(homeDir, 'config.toml');

  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      return toml.parse(content) as AppConfig;
    } catch (err) {
      console.warn(`Warning: Failed to load config from ${configPath}, returning empty config:`, err);
    }
  }

  return {};
}

// Saves the configuration file to the resolved home directory
export function saveConfig(config: AppConfig): void {
  const homeDir = resolveHomeDir();
  if (!fs.existsSync(homeDir)) {
    fs.mkdirSync(homeDir, { recursive: true });
  }
  const configPath = path.join(homeDir, 'config.toml');
  try {
    const tomlString = toml.stringify(config as any);
    fs.writeFileSync(configPath, tomlString, 'utf8');
  } catch (err) {
    console.error(`Error: Failed to save config to ${configPath}:`, err);
  }
}

// Loads env variables from resolved home directory
export function loadEnv(): Record<string, string> {
  const homeDir = resolveHomeDir();
  const envPath = path.join(homeDir, '.env');
  const result: Record<string, string> = {};

  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      const parsed = dotenv.parse(content);
      for (const [key, val] of Object.entries(parsed)) {
        process.env[key] = val;
        result[key] = val;
      }
    } catch (err) {
      console.warn(`Warning: Failed to parse .env from ${envPath}:`, err);
    }
  }
  return result;
}

// Saves env variables to resolved home directory
export function saveEnv(env: Record<string, string>): void {
  const homeDir = resolveHomeDir();
  if (!fs.existsSync(homeDir)) {
    fs.mkdirSync(homeDir, { recursive: true });
  }
  const envPath = path.join(homeDir, '.env');
  try {
    const envString = Object.entries(env)
      .map(([key, val]) => `${key}=${val}`)
      .join('\n') + '\n';
    fs.writeFileSync(envPath, envString, 'utf8');
  } catch (err) {
    console.error(`Error: Failed to save .env to ${envPath}:`, err);
  }
}
