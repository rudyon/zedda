import { WebSocket } from 'ws';
import type {
  AgentSession,
  AgentSessionRuntime
} from '@earendil-works/pi-coding-agent';

export interface TuiClientConnection {
  ws: WebSocket;
  runtime: AgentSessionRuntime;
  session: AgentSession;
}

export function connectToGateway(
  wsUrl: string,
  initData: any,
  cwd: string,
  agentDir: string
): Promise<TuiClientConnection> {
  return new Promise(async (resolve, reject) => {
    const {
      createAgentSessionRuntime,
      createAgentSessionServices,
      createAgentSessionFromServices,
      SessionManager
    } = await import('@earendil-works/pi-coding-agent');

    // 1. Reconstruct session history in-memory on the client
    const sessionManager = SessionManager.inMemory(cwd);
    
    // Set the session ID matching the gateway session
    if (initData.header?.id) {
      sessionManager.newSession({ id: initData.header.id });
    }

    // Populate history entries
    if (initData.entries && Array.isArray(initData.entries)) {
      for (const entry of initData.entries) {
        sessionManager['fileEntries'].push(entry);
      }
      sessionManager['_buildIndex']();
    }

    // 2. Create local AgentSessionRuntime
    const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }: any) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
      });

      // Find the active model in the local registry to prevent startup failures
      let model;
      if (initData.model) {
        model = services.modelRegistry.find(initData.model.provider, initData.model.id);
      }

      const sessionOptions: any = {
        services,
        sessionManager,
        sessionStartEvent,
      };
      if (model) {
        sessionOptions.model = model;
      }
      if (initData.thinkingLevel) {
        sessionOptions.thinkingLevel = initData.thinkingLevel;
      }

      const created = await createAgentSessionFromServices(sessionOptions);

      return {
        ...created,
        services,
        diagnostics: []
      };
    };

    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir,
      sessionManager
    });

    const session = runtime.session;
    const ws = new WebSocket(wsUrl);

    let promptPromiseResolve: (() => void) | null = null;
    let navigatePromiseResolve: ((result: any) => void) | null = null;

    // 3. Intercept local session calls and delegate to Gateway
    session.prompt = async (text, options) => {
      ws.send(JSON.stringify({ type: 'prompt', text, options }));
      await new Promise<void>((r) => {
        promptPromiseResolve = r;
      });
    };

    session.abort = async () => {
      ws.send(JSON.stringify({ type: 'abort' }));
    };

    const originalNavigate = session.navigateTree.bind(session);
    session.navigateTree = async (targetId, options) => {
      ws.send(JSON.stringify({ type: 'navigate', targetId, options }));
      return new Promise<any>((r) => {
        navigatePromiseResolve = r;
      });
    };

    const originalSetModel = session.setModel.bind(session);
    session.setModel = async (model) => {
      await originalSetModel(model);
      ws.send(JSON.stringify({ type: 'set_model', provider: model.provider, modelId: model.id }));
    };

    const originalSetThinking = session.setThinkingLevel.bind(session);
    session.setThinkingLevel = (level) => {
      originalSetThinking(level);
      ws.send(JSON.stringify({ type: 'set_thinking', level }));
    };

    // 4. Listen to Gateway events
    ws.on('open', () => {
      resolve({ ws, runtime, session });
    });

    ws.on('error', (err) => {
      reject(err);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'event') {
          // Emit the event locally so InteractiveMode captures it
          session['_emit'](msg.event);
        } else if (msg.type === 'prompt_done') {
          if (promptPromiseResolve) {
            promptPromiseResolve();
            promptPromiseResolve = null;
          }
        } else if (msg.type === 'navigate_done') {
          if (navigatePromiseResolve) {
            navigatePromiseResolve(msg.result);
            navigatePromiseResolve = null;
          }
        }
      } catch (err) {
        console.error('[TUI Client] Error handling ws message:', err);
      }
    });

    ws.on('close', () => {
      console.log('\n[TUI Client] Gateway connection closed.');
      if (promptPromiseResolve) {
        promptPromiseResolve();
      }
      if (navigatePromiseResolve) {
        navigatePromiseResolve({ cancelled: true });
      }
    });
  });
}
