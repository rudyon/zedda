import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn } from 'child_process';
import { loadConfig, loadEnv } from '../core/config.js';
import { getOrCreateSession, shutdownAllSessions } from '../core/session.js';
import { startDiscordBot, stopDiscordBot } from '../adapters/discord.js';

let httpServer: http.Server | null = null;
let wss: WebSocketServer | null = null;

// Starts the Gateway monolithic daemon
export async function runGateway(): Promise<void> {
  const config = loadConfig();
  const port = config.gateway?.port || 9332;

  // Enforce single-instance lock by binding to the HTTP port
  httpServer = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'zedda-gateway' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/restart') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'restarting' }));

      console.log('[Gateway] Received restart request. Initiating graceful restart...');
      
      // Perform graceful shutdown
      await stopDiscordBot();
      await shutdownAllSessions();
      
      if (wss) {
        wss.close();
      }
      if (httpServer) {
        httpServer.close();
      }

      // Spawn a new gateway instance in the background
      const binary = process.argv[0] || 'node';
      const entryPoint = process.argv[1] || '';
      const args = [entryPoint, 'gateway', 'run'];
      console.log(`[Gateway] Spawning new process: ${binary} ${args.join(' ')}`);
      
      const child: any = spawn(binary, args, {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env }
      });
      if (child && typeof child.unref === 'function') {
        child.unref();
      }

      process.exit(0);
    }

    res.writeHead(404);
    res.end();
  });

  // Handle port-in-use error gracefully
  httpServer.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Error: Gateway port ${port} is already in use.`);
      console.error('Another gateway instance is likely running. Aborting startup to prevent conflicts.');
      process.exit(1);
    } else {
      console.error('[Gateway] HTTP server error:', err);
    }
  });

  // Setup WebSocket server for TUI client connection
  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    if (request.url === '/tui') {
      wss?.handleUpgrade(request, socket, head, (ws) => {
        wss?.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', async (ws: WebSocket) => {
    console.log('[Gateway] TUI client connected.');
    
    // Retrieve TUI session (starts unique session per connection)
    // For TUI, we can use a unique connection ID as channel ID to ensure distinct session
    const tuiChannelId = `tui-${Date.now()}`;
    let session;
    try {
      session = await getOrCreateSession(tuiChannelId);
    } catch (err) {
      console.error('[Gateway] Failed to create session for TUI connection:', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to create session context.' }));
      ws.close();
      return;
    }

    // Subscribe to session events and forward them to TUI client
    const unsubscribe = session.subscribe((event) => {
      ws.send(JSON.stringify({ type: 'event', event }));
    });

    // Send initial session data (all entries) to the client so it can reconstruct history
    const entries = session.sessionManager.getEntries();
    const header = session.sessionManager.getHeader();
    ws.send(JSON.stringify({
      type: 'init',
      header,
      entries,
      model: session.model ? { provider: session.model.provider, id: session.model.id } : null,
      thinkingLevel: session.thinkingLevel
    }));

    ws.on('message', async (messageData) => {
      try {
        const msg = JSON.parse(messageData.toString());
        if (msg.type === 'prompt') {
          console.log(`[Gateway] Executing TUI prompt: "${msg.text}"`);
          await session.prompt(msg.text, msg.options);
          ws.send(JSON.stringify({ type: 'prompt_done' }));
        } else if (msg.type === 'abort') {
          console.log('[Gateway] Aborting TUI execution');
          await session.abort();
        } else if (msg.type === 'navigate') {
          console.log(`[Gateway] Navigating tree to target: ${msg.targetId}`);
          const result = await session.navigateTree(msg.targetId, msg.options);
          ws.send(JSON.stringify({ type: 'navigate_done', result }));
        } else if (msg.type === 'set_model') {
          if (session.modelRegistry) {
            const model = session.modelRegistry.find(msg.provider, msg.modelId);
            if (model) {
              await session.setModel(model);
              ws.send(JSON.stringify({ type: 'set_model_done', success: true }));
            } else {
              ws.send(JSON.stringify({ type: 'set_model_done', success: false, error: 'Model not found' }));
            }
          }
        } else if (msg.type === 'set_thinking') {
          session.setThinkingLevel(msg.level);
          ws.send(JSON.stringify({ type: 'set_thinking_done' }));
        }
      } catch (err) {
        console.error('[Gateway] Error handling client message:', err);
        ws.send(JSON.stringify({ type: 'error', message: String(err) }));
      }
    });

    ws.on('close', () => {
      console.log('[Gateway] TUI client disconnected.');
      unsubscribe();
      // Let the 1-hour eviction loop handle the cleanup of this session in the background
    });
  });

  // Start HTTP server
  httpServer.listen(port, '127.0.0.1', () => {
    console.log(`[Gateway] Server is listening on http://127.0.0.1:${port}`);
    
    // Load .env keys and start Discord bot if configured
    loadEnv();
    startDiscordBot().catch(err => {
      console.error('[Gateway] Failed to start Discord adapter bot:', err);
    });
  });

  // Handle graceful process shutdown (SIGINT/SIGTERM)
  const shutdown = async () => {
    console.log('[Gateway] Shutting down gateway monolith gracefully...');
    await stopDiscordBot();
    await shutdownAllSessions();
    if (wss) wss.close();
    if (httpServer) httpServer.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Gracefully restarts a running gateway by calling its HTTP /restart endpoint
export function restartGateway(): Promise<void> {
  const config = loadConfig();
  const port = config.gateway?.port || 9332;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: port,
        path: '/restart',
        method: 'POST',
        headers: {
          'Content-Length': 0
        }
      },
      (res) => {
        if (res.statusCode === 200) {
          console.log('Gateway restart request sent successfully.');
          resolve();
        } else {
          reject(new Error(`Failed to restart gateway. Status code: ${res.statusCode}`));
        }
      }
    );

    req.on('error', (err) => {
      console.error('Error connecting to gateway server:', err.message);
      reject(new Error('Gateway server is not running or unreachable.'));
    });

    req.end();
  });
}
