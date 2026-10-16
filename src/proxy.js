'use strict';

const readline = require('node:readline');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { SettlementTracker } = require('./settlement.js');
const { ModelCatalogManager } = require('./model_catalog.js');
const { SubagentBridge } = require('./subagent.js');
const { resolveOmpPath } = require('./cli.js');
const { setupSessionSymlink } = require('./symlink.js');

/**
 * Creates the bidirectional stdio proxy pipeline.
 */
function createProxyPipeline(options) {
  const {
    clientIn,
    clientOut,
    childIn,
    childOut,
    settlementTracker = new SettlementTracker(),
    modelManager = new ModelCatalogManager(),
    subagentBridge = new SubagentBridge(),
    ompPath = 'omp'
  } = options;

  let rlClient = null;
  let rlChild = null;

  function start() {
    rlClient = readline.createInterface({
      input: clientIn,
      crlfDelay: Infinity,
      terminal: false
    });

    rlChild = readline.createInterface({
      input: childOut,
      crlfDelay: Infinity,
      terminal: false
    });

    // Upstream stream: Client (T3 Code) -> Translator -> OMP
    rlClient.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // 1. Notify settlement tracker of incoming turn commands
      settlementTracker.handleUpstreamFrame(trimmed);

      // 2. Intercept get_available_models
      const modelResult = modelManager.handleUpstreamFrame(trimmed, ompPath);
      if (modelResult.intercepted && modelResult.response) {
        clientOut.write(modelResult.response);
        return; // Intercepted: Do not forward to OMP
      }

      // 3. Byte-preserving transparent passthrough
      childIn.write(line + '\n');
    });

    // Downstream stream: OMP -> Translator -> Client (T3 Code)
    rlChild.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // 1. Check settlement tracker (session_settled -> agent_settled, prompt_result)
      const settleResult = settlementTracker.handleDownstreamFrame(trimmed);
      if (settleResult.handled) {
        if (!settleResult.suppress && settleResult.emit) {
          clientOut.write(settleResult.emit);
        }
        return;
      }

      // 2. Check subagent bridge
      const subResult = subagentBridge.handleDownstreamFrame(trimmed);
      if (subResult.handled && subResult.line) {
        clientOut.write(subResult.line);
        return;
      }

      // 3. Byte-preserving transparent passthrough (diffs, streaming tokens, dialogs, usage)
      clientOut.write(line + '\n');
    });
  }

  function stop() {
    if (rlClient) rlClient.close();
    if (rlChild) rlChild.close();
  }

  return {
    start,
    stop,
    settlementTracker,
    modelManager,
    subagentBridge
  };
}

/**
 * Spawns OMP child process and starts proxying standard I/O.
 * @param {string[]} ompArgs Arguments to pass to omp
 */
function spawnAndProxy(ompArgs) {
  const ompPath = resolveOmpPath();

  // Ensure ~/.pi/agent/sessions -> ~/.omp/agent/sessions symlink exists for T3 usage scraper
  setupSessionSymlink(true);

  // Pre-warm model catalog cache in background so get_available_models is instantaneous
  const modelManager = new ModelCatalogManager();
  try {
    modelManager.getModels(ompPath);
  } catch {
    // Ignore pre-warm failure; will retry on demand
  }

  const childEnv = {
    ...process.env,
    PI_CODING_AGENT_DIR: path.join(os.homedir(), '.omp', 'agent')
  };

  const child = spawn(ompPath, ompArgs, {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: childEnv
  });

  const pipeline = createProxyPipeline({
    clientIn: process.stdin,
    clientOut: process.stdout,
    childIn: child.stdin,
    childOut: child.stdout,
    modelManager,
    ompPath
  });

  pipeline.start();

  // Propagate termination signals to child process
  const forwardSignal = (sig) => {
    if (child && !child.killed) {
      try {
        child.kill(sig);
      } catch {
        // Child might have already exited
      }
    }
  };

  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));
  process.on('SIGHUP', () => forwardSignal('SIGHUP'));

  // Clean shutdown when child process exits
  child.on('close', (code, signal) => {
    pipeline.stop();
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });

  child.on('error', (err) => {
    console.error(`[omp-t3] Failed to spawn omp child process (${ompPath}):`, err);
    process.exit(1);
  });
}

module.exports = {
  createProxyPipeline,
  spawnAndProxy
};
