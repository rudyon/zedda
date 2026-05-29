import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import * as p from '@clack/prompts';
import { resolveHomeDir, saveConfig, saveEnv } from '../core/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runSetup(): Promise<void> {
  p.intro('Welcome to the zedda Setup Wizard!');

  // 1. LLM Provider (Single Select)
  const provider = await p.select({
    message: 'Select LLM Provider:',
    options: [
      { value: 'openrouter', label: 'OpenRouter' },
      { value: 'wandb', label: 'W&B Serverless Inference' }
    ]
  });

  if (p.isCancel(provider)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  // 2. API Key
  const apiKeyPrompt = provider === 'wandb' ? 'Enter W&B API Key:' : 'Enter OpenRouter API Key:';
  const apiKey = await p.text({
    message: apiKeyPrompt,
    validate: (value) => {
      if (!value || !value.trim()) return 'API Key cannot be empty.';
      return;
    }
  });

  if (p.isCancel(apiKey)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  // 3. Model (Single Select)
  const modelOptions = provider === 'wandb' 
    ? [ { value: 'zai-org/GLM-5.1', label: 'GLM 5.1' } ]
    : [
        { value: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
        { value: 'z-ai/glm-5.1', label: 'GLM 5.1' }
      ];

  const model = await p.select({
    message: 'Select Model:',
    options: modelOptions
  });

  if (p.isCancel(model)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  // 4. Adapters (Multi Select)
  const adapters = await p.multiselect({
    message: 'Select Adapters to configure:',
    options: [
      { value: 'discord', label: 'Discord', hint: 'recommended' }
    ],
    required: false
  });

  if (p.isCancel(adapters)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  // Initialize configurations
  let discordEnabled = false;
  let discordToken = '';
  let discordAllowedUsers: string[] = [];
  let discordPrimaryUser = '';

  // If Discord adapter is selected, configure it
  const selectedAdapters = adapters as string[];
  if (selectedAdapters.includes('discord')) {
    discordEnabled = true;

    // A. Discord Token
    const token = await p.text({
      message: 'Enter Discord Bot Token:',
      validate: (value) => {
        if (!value || !value.trim()) return 'Discord Bot Token cannot be empty.';
        return;
      }
    });

    if (p.isCancel(token)) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }
    discordToken = token;

    // B. Allowed Users
    const allowed = await p.text({
      message: 'Enter Discord User IDs allowed to interact with the bot (comma-separated):',
      placeholder: '123456789012345678, 987654321098765432',
      validate: (value) => {
        if (!value || !value.trim()) return 'Allowed users list cannot be empty.';
        const parts = value.split(',').map(s => s.trim());
        if (parts.some(p => !p || !/^\d+$/.test(p))) {
          return 'User IDs must contain only digits.';
        }
        return;
      }
    });

    if (p.isCancel(allowed)) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }
    discordAllowedUsers = allowed.split(',').map(s => s.trim());

    // C. Primary User
    const primary = await p.text({
      message: 'Enter the Primary Discord User ID:',
      validate: (value) => {
        const id = value ? value.trim() : '';
        if (!id) return 'Primary User ID cannot be empty.';
        if (!/^\d+$/.test(id)) return 'User ID must contain only digits.';
        if (!discordAllowedUsers.includes(id)) {
          return 'Primary user must be one of the allowed users.';
        }
        return;
      }
    });

    if (p.isCancel(primary)) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }
    discordPrimaryUser = primary.trim();
  }

  // Resolve target home directory
  const homeDir = resolveHomeDir();
  if (!fs.existsSync(homeDir)) {
    fs.mkdirSync(homeDir, { recursive: true });
  }

  // Prepare and write config.toml
  const config = {
    gateway: {
      port: 9332
    },
    paths: {
      home: homeDir
    },
    llm: {
      provider: provider as string,
      model: model as string
    },
    adapters: {
      discord: {
        enabled: discordEnabled,
        allowed_users: discordAllowedUsers,
        primary_user: discordPrimaryUser
      }
    }
  };
  saveConfig(config);

  // Prepare and write .env
  const env: Record<string, string> = {};
  if (provider === 'openrouter') {
    env.OPENROUTER_API_KEY = apiKey as string;
  } else if (provider === 'wandb') {
    env.WANDB_API_KEY = apiKey as string;
  }
  
  if (discordEnabled) {
    env.DISCORD_BOT_TOKEN = discordToken;
  }
  saveEnv(env);

  // Configure models.json for custom provider registration (Wandb)
  const modelsJsonPath = path.join(homeDir, 'models.json');
  let modelsConfig: any = { providers: {} };
  if (fs.existsSync(modelsJsonPath)) {
    try {
      modelsConfig = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8'));
    } catch {
      // Ignored
    }
  }
  if (!modelsConfig.providers) {
    modelsConfig.providers = {};
  }
  
  if (provider === 'wandb') {
    modelsConfig.providers.wandb = {
      name: 'W&B Serverless Inference',
      baseUrl: 'https://api.inference.wandb.ai/v1',
      apiKey: 'WANDB_API_KEY',
      api: 'openai-completions',
      authHeader: true,
      models: [
        {
          id: 'zai-org/GLM-5.1',
          name: 'GLM 5.1',
          reasoning: false,
          contextWindow: 131072,
          maxTokens: 2048
        }
      ]
    };
    fs.writeFileSync(modelsJsonPath, JSON.stringify(modelsConfig, null, 2), 'utf8');
    p.log.success('Configured models.json for W&B Serverless Inference API.');
  }

  // Copy PERSONA.md if missing
  const personaDestPath = path.join(homeDir, 'PERSONA.md');
  if (!fs.existsSync(personaDestPath)) {
    const rootDir = path.join(__dirname, '..', '..');
    const personaSrcPath = path.join(rootDir, 'templates', 'PERSONA.md');
    try {
      if (fs.existsSync(personaSrcPath)) {
        fs.copyFileSync(personaSrcPath, personaDestPath);
        p.log.success('Copied default PERSONA.md to home directory.');
      } else {
        p.log.warn(`Warning: Could not find templates/PERSONA.md at ${personaSrcPath}. Skipping persona file copy.`);
      }
    } catch (err) {
      p.log.error(`Error copying templates/PERSONA.md: ${err}`);
    }
  } else {
    p.log.info('PERSONA.md already exists in home directory. Leaving untouched.');
  }

  p.outro(`Setup complete! Configuration saved to ${homeDir}. You can now start the gateway or talk to your symbiont via the TUI.`);
}
