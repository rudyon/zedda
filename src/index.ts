#!/usr/bin/env node

import { buildCommand, buildRouteMap, buildApplication, run } from '@stricli/core';

const setupCmd = buildCommand({
  docs: {
    brief: 'Run the interactive setup wizard to configure the symbiont.',
  },
  parameters: {},
  async func() {
    try {
      const { runSetup } = await import('./commands/setup.js');
      await runSetup();
    } catch (err) {
      console.error('Error running setup:', err);
      process.exit(1);
    }
  },
});

const tuiCmd = buildCommand({
  docs: {
    brief: 'Talk to your symbiont in a terminal user interface.',
  },
  parameters: {},
  async func() {
    try {
      const { runTui } = await import('./commands/tui.js');
      await runTui();
    } catch (err) {
      console.error('Error running TUI:', err);
      process.exit(1);
    }
  },
});

const gatewayRunCmd = buildCommand({
  docs: {
    brief: 'Start the gateway in the foreground.',
  },
  parameters: {},
  async func() {
    try {
      const { runGateway } = await import('./commands/gateway.js');
      await runGateway();
    } catch (err) {
      console.error('Error running gateway:', err);
      process.exit(1);
    }
  },
});

const gatewayRestartCmd = buildCommand({
  docs: {
    brief: 'Gracefully restart the running gateway.',
  },
  parameters: {},
  async func() {
    try {
      const { restartGateway } = await import('./commands/gateway.js');
      await restartGateway();
    } catch (err) {
      console.error('Error restarting gateway:', err);
      process.exit(1);
    }
  },
});

const gatewayRoute = buildRouteMap({
  docs: {
    brief: 'Manage the zedda gateway process.',
  },
  routes: {
    run: gatewayRunCmd,
    restart: gatewayRestartCmd,
  },
});

const routes = buildRouteMap({
  docs: {
    brief: 'zedda: An agentic orchestration harness for running one\'s own AI symbiont.',
  },
  routes: {
    setup: setupCmd,
    tui: tuiCmd,
    gateway: gatewayRoute,
  },
});

const app = buildApplication(routes, {
  name: 'zedda',
  versionInfo: {
    currentVersion: '0.1.0',
  },
});

await run(app, process.argv.slice(2), { process: process as any });
