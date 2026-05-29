import * as http from 'http';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { spawn, ChildProcess } from 'child_process';
import { WebSocket } from 'ws';
import * as p from '@clack/prompts';
import { resolveHomeDir, loadConfig } from '../core/config.js';
import { connectToGateway } from '../adapters/tui-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let lastConnectionError: any = null;

// Check if Gateway health endpoint is active
function checkGatewayActive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', (err) => {
      lastConnectionError = err;
      resolve(false);
    });
    req.end();
  });
}

// Helper to wait for a number of milliseconds
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runTui(): Promise<void> {
  const config = loadConfig();
  const port = config.gateway?.port || 9332;
  const homeDir = resolveHomeDir();
  const cwd = process.cwd();

  let gatewayProcess: ChildProcess | null = null;
  lastConnectionError = null;

  // 1. Check if Gateway is running
  let isActive = await checkGatewayActive(port);
  if (!isActive) {
    p.intro('zedda TUI Mode');
    const startGateway = await p.confirm({
      message: 'Gateway is not running. Start it now?',
      active: 'yes',
      inactive: 'no'
    });

    if (p.isCancel(startGateway) || !startGateway) {
      p.cancel('TUI mode aborted: Gateway is not running.');
      process.exit(0);
    }

    const entrypoint = path.join(__dirname, '..', 'index.js');
    const binary = process.argv[0] || 'node';
    const gatewayPath = process.argv[1] || '';
    console.log(`[TUI] Spawning gateway daemon: ${binary} ${entrypoint} gateway run`);
    
    gatewayProcess = spawn(binary, [gatewayPath, 'gateway', 'run'], {
      detached: false,
      stdio: 'ignore'
    });

    let spawnError: any = null;

    gatewayProcess.on('error', (err) => {
      spawnError = err;
    });

    // Handle TUI process exit to kill the child Gateway process
    const cleanup = () => {
      if (gatewayProcess && !gatewayProcess.killed) {
        console.log('\n[TUI] Terminating child gateway process...');
        gatewayProcess.kill();
      }
    };
    process.on('exit', cleanup);
    process.on('SIGINT', () => {
      cleanup();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      cleanup();
      process.exit(0);
    });

    // Wait for the server to startup and listen on the port
    let retries = 90;
    while (retries > 0 && !spawnError) {
      await delay(1000);
      isActive = await checkGatewayActive(port);
      if (isActive) break;
      retries--;
    }

    if (!isActive) {
      console.error('Error: Failed to start and connect to the gateway server.');
      if (spawnError) {
        console.error(`Spawn error: ${spawnError.message}`);
      }
      if (lastConnectionError) {
        console.error(`Connection error to gateway: ${lastConnectionError.message}`);
      }
      cleanup();
      process.exit(1);
    }
  }

  // 2. Establish connection and retrieve history/state
  const wsUrl = `ws://127.0.0.1:${port}/tui`;
  console.log(`[TUI] Connecting to gateway at ${wsUrl}...`);

  const initData = await new Promise<any>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => {
      // Just waiting for the init message
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'init') {
          ws.close();
          resolve(msg);
        }
      } catch (err) {
        ws.close();
        reject(err);
      }
    });
    ws.on('error', (err) => {
      ws.close();
      reject(err);
    });
  });

  // 3. Connect as TUI client mapping session proxy
  const connection = await connectToGateway(wsUrl, initData, cwd, homeDir);

  // 4. Run the interactive Terminal UI
  const { InteractiveMode } = await import('@earendil-works/pi-coding-agent');
  const interactiveMode = new InteractiveMode(connection.runtime, {
    verbose: false
  });

  try {
    await interactiveMode.run();
  } catch (err) {
    console.error('[TUI] Error running TUI loop:', err);
  } finally {
    connection.ws.close();
    await connection.runtime.dispose();
    if (gatewayProcess && !gatewayProcess.killed) {
      console.log('[TUI] Terminating child gateway process...');
      gatewayProcess.kill();
    }
  }
}
