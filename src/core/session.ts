import * as fs from 'fs';
import * as path from 'path';
import { AgentSession, createAgentSession, getAgentDir, SessionManager } from '@earendil-works/pi-coding-agent';
import { resolveHomeDir, loadConfig } from './config.js';

interface ActiveSession {
  session: AgentSession;
  sessionManager: SessionManager;
  lastActivity: number;
  timer: NodeJS.Timeout;
}

// Maps channelId (TUI or Discord channel ID) to active session record
const activeSessions = new Map<string, ActiveSession>();

// Eviction timeout in milliseconds (1 hour)
const EVICTION_TIMEOUT = 60 * 60 * 1000;

// Path to the session mapping file in the home directory
function getMappingFilePath(): string {
  return path.join(resolveHomeDir(), 'sessions_mapping.json');
}

// Load session mapping from file
function loadSessionMapping(): Record<string, string> {
  const filePath = getMappingFilePath();
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    } catch (err) {
      console.warn('Warning: Failed to load sessions_mapping.json:', err);
    }
  }
  return {};
}

// Save session mapping to file
function saveSessionMapping(mapping: Record<string, string>): void {
  const filePath = getMappingFilePath();
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(mapping, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving sessions_mapping.json:', err);
  }
}

// Evict a session from memory
async function evictSession(channelId: string): Promise<void> {
  const record = activeSessions.get(channelId);
  if (!record) return;

  console.log(`[SessionManager] Evicting session for channel ${channelId} due to 1-hour inactivity.`);
  
  clearTimeout(record.timer);
  activeSessions.delete(channelId);

  try {
    // SessionManager writes incrementally, but we can call dispose to release resources
    await record.session.dispose();
  } catch (err) {
    console.error(`Error disposing session for channel ${channelId}:`, err);
  }
}

// Resets/updates the inactivity timer for a session
function resetInactivityTimer(channelId: string): void {
  const record = activeSessions.get(channelId);
  if (!record) return;

  clearTimeout(record.timer);
  record.lastActivity = Date.now();
  record.timer = setTimeout(() => {
    evictSession(channelId).catch(console.error);
  }, EVICTION_TIMEOUT);
}

// Retrieves or creates/re-hydrates an AgentSession for a specific channel
export async function getOrCreateSession(channelId: string): Promise<AgentSession> {
  // 1. Check in-memory active cache
  const activeRecord = activeSessions.get(channelId);
  if (activeRecord) {
    resetInactivityTimer(channelId);
    return activeRecord.session;
  }

  // 2. Resolve paths and config
  const homeDir = resolveHomeDir();
  const config = loadConfig();
  const provider = config.llm?.provider || 'openrouter';
  const modelId = config.llm?.model || 'deepseek/deepseek-v4-flash';

  const sessionsDir = path.join(homeDir, 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }

  // 3. Resolve mapping from channel ID to session file
  const mapping = loadSessionMapping();
  let sessionFile = mapping[channelId];
  let sessionManager: SessionManager;

  const cwd = process.cwd();

  if (sessionFile && fs.existsSync(sessionFile)) {
    console.log(`[SessionManager] Re-hydrating existing session for channel ${channelId} from ${sessionFile}`);
    sessionManager = SessionManager.open(sessionFile, sessionsDir, cwd);
  } else {
    console.log(`[SessionManager] Creating new session for channel ${channelId}`);
    sessionManager = SessionManager.create(cwd, sessionsDir);
    // Get the newly created session file path
    const newFile = sessionManager.getSessionFile();
    if (newFile) {
      sessionFile = newFile;
      mapping[channelId] = newFile;
      saveSessionMapping(mapping);
    }
  }

  // 4. Create default resource loader with custom persona prompt compilation
  const personaPath = path.join(homeDir, 'PERSONA.md');
  
  const { DefaultResourceLoader } = await import('@earendil-works/pi-coding-agent');
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: homeDir,
    systemPromptOverride: (basePrompt: string | undefined) => {
      let persona = '';
      if (fs.existsSync(personaPath)) {
        try {
          persona = fs.readFileSync(personaPath, 'utf8').trim();
        } catch (err) {
          console.warn(`Warning: Failed to read PERSONA.md from ${personaPath}:`, err);
        }
      } else {
        console.warn(`Warning: PERSONA.md is missing from ${personaPath}`);
      }
      
      if (persona) {
        return `${basePrompt || ''}\n\n${persona}`;
      }
      return basePrompt || '';
    }
  });

  // Create the session
  const { session } = await createAgentSession({
    cwd,
    agentDir: homeDir,
    sessionManager,
    resourceLoader: loader
  });

  // Bind empty extensions (or default extensions)
  await session.bindExtensions({});

  // 5. Store in-memory
  const timer = setTimeout(() => {
    evictSession(channelId).catch(console.error);
  }, EVICTION_TIMEOUT);

  activeSessions.set(channelId, {
    session,
    sessionManager,
    lastActivity: Date.now(),
    timer
  });

  return session;
}

// Disposes all active sessions (e.g. on gateway shutdown)
export async function shutdownAllSessions(): Promise<void> {
  console.log('[SessionManager] Disposing all active sessions...');
  const keys = Array.from(activeSessions.keys());
  for (const key of keys) {
    const record = activeSessions.get(key);
    if (record) {
      clearTimeout(record.timer);
      try {
        await record.session.dispose();
      } catch (err) {
        console.error(`Error disposing session during shutdown:`, err);
      }
    }
  }
  activeSessions.clear();
}
