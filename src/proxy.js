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
const { ContractDoctor } = require('./doctor.js');
const pkg = require('../package.json');


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
    doctor = new ContractDoctor({ shimVersion: pkg.version }),
    modelManager = new ModelCatalogManager((err) => doctor.reportDiscoveryFailure(err)),
    subagentBridge = new SubagentBridge(),
    ompPath = 'omp'
  } = options;

  let rlClient = null;
  let rlChild = null;
  let subagentSubscriptionSent = false;
  doctor.onSynth = (line) => clientOut.write(line);
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

      // 1. Notify settlement tracker of incoming turn commands; a manual
      //    compact request also synthesizes a downstream compaction_start
      //    (omp's manual compact emits no compaction events of its own).
      const upstreamResult = settlementTracker.handleUpstreamFrame(trimmed);
      if (upstreamResult && upstreamResult.emit) {
        clientOut.write(upstreamResult.emit);
      }

      // 2. Intercept get_available_models
      const modelResult = modelManager.handleUpstreamFrame(trimmed, ompPath);
      if (modelResult.intercepted && modelResult.response) {
        clientOut.write(modelResult.response);
        return; // Intercepted: Do not forward to OMP
      }

      // 3. Gracefully answer get_commands if OMP does not support it
      if (trimmed.includes('"type":"get_commands"') || trimmed.includes('"type": "get_commands"')) {
        let reqId = '1';
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.id) reqId = String(parsed.id);
        } catch {
          const m = trimmed.match(/"id"\s*:\s*("([^"]+)"|(\d+))/);
          if (m) reqId = m[2] !== undefined ? m[2] : m[3];
        }
        clientOut.write(JSON.stringify({
          id: reqId,
          type: 'response',
          command: 'get_commands',
          success: true,
          data: { commands: [] }
        }) + '\n');
        return;
      }

      // 4. Normalize set_model if redundant provider prefix is present (e.g. from existing thread state)
      if (trimmed.includes('"type":"set_model"') || trimmed.includes('"type": "set_model"')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && parsed.type === 'set_model' && parsed.provider && typeof parsed.modelId === 'string') {
            let cleanId = parsed.modelId;
            const prefix = `${parsed.provider}/`;
            while (cleanId.startsWith(prefix) && cleanId.length > prefix.length) {
              cleanId = cleanId.slice(prefix.length);
            }
            if (cleanId !== parsed.modelId) {
              parsed.modelId = cleanId;
              childIn.write(JSON.stringify(parsed) + '\n');
              return;
            }
          }
        } catch {
          // Fall through to default passthrough
        }
      }

      // 5. Byte-preserving transparent passthrough
      childIn.write(line + '\n');
    });

    // Downstream stream: OMP -> Translator -> Client (T3 Code)
    rlChild.on('line', (line) => {
      const trimmed = line.trim();
      // 0. On the child's ready frame, opt into subagent frame forwarding so
      //    the bridge can enrich T3's subagent cards with live status/text.
      if (!subagentSubscriptionSent && trimmed.includes('"type":"ready"')) {
        subagentSubscriptionSent = true;
        childIn.write(JSON.stringify({ type: 'set_subagent_subscription', level: 'events' }) + '\n');
      }

      // 0.5 Contract doctor: arms the settle watchdog on OMP's settlement
      //     announcement, clears it on session_settled.
      doctor.observeDownstream(trimmed);

      // 1. Check settlement tracker (session_settled -> agent_settled, prompt_result)
      const settleResult = settlementTracker.handleDownstreamFrame(trimmed);
      if (settleResult.handled) {
        if (!settleResult.suppress && settleResult.emit) {
          clientOut.write(settleResult.emit);
          if (settleResult.emit.includes('"agent_settled"')) doctor.noteSettled();
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
    doctor.stop();
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

  const doctor = new ContractDoctor({ shimVersion: pkg.version });
  const modelManager = new ModelCatalogManager((err) => doctor.reportDiscoveryFailure(err));
  // Pre-warm model catalog cache so get_available_models is instantaneous.
  // MUST be async: a synchronous execSync here stalls every frame until the
  // omp models --json subprocess finishes (~0.6s+ with the real binary).
  modelManager.prewarm(ompPath);

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
    doctor,
    ompPath
  });
  doctor.init(ompPath);

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
