'use strict';

const readline = require('node:readline');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { SettlementTracker } = require('./settlement.js');
const { HoldOpenTracker } = require('./notices.js');
const { ModelCatalogManager } = require('./model_catalog.js');
const { SubagentBridge } = require('./subagent.js');
const { CommandBridge } = require('./commands.js');
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
    commandBridge = new CommandBridge(),
    ompPath = 'omp'
  } = options;

  let rlClient = null;
  let rlChild = null;
  let subagentSubscriptionSent = false;
  doctor.onSynth = (line) => clientOut.write(line);
  doctor.onNotice = (line) => clientOut.write(line);
  // Feature 002 FR4: hold-open notices. The tracker writes notify frames to
  // the consumer while the run is kept open for pending async work; the
  // subagent bridge supplies the only count the bridge can state honestly.
  const holdOpen = new HoldOpenTracker((line) => clientOut.write(line));
  settlementTracker.pendingSubagents = () => subagentBridge.pendingCount();
  settlementTracker.onHoldOpen = (info) => {
    holdOpen.tick(info);
    // Settlement is withheld for pending work: also reconcile the live
    // child list so the hold-open count and card details stay truthful.
    requestSubagentRefresh();
  };
  // Interrupt translation: terminalize tracked subagents for T3 and
  // hard-cancel omp-side children BEFORE the settle synthesis runs - after
  // agent_settled T3's Pi adapter drops every frame, so this is the only
  // window in which the cards can reach their terminal state.
  settlementTracker.onAbort = () => {
    const sweep = subagentBridge.abortSweep();
    for (const line of sweep.toClient) clientOut.write(line);
    for (const line of sweep.toOmp) childIn.write(line);
  };
  // Reconciliation against omp's authoritative live child list
  // (get_subagents): heals missed events and refreshes card details.
  const requestSubagentRefresh = () => {
    const line = subagentBridge.refreshRequest();
    if (line) childIn.write(line);
  };
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

      // 3. Serve get_commands from OMP's live catalog (translated to the Pi
      //    dialect) instead of an empty list — this populates T3's `/` and `$`
      //    menus with OMP's builtins and skills.
      if (trimmed.includes('"type":"get_commands"') || trimmed.includes('"type": "get_commands"')) {
        let reqId = '1';
        try {
          const parsed = JSON.parse(trimmed);
          // Echo the id with its original JSON type — T3 correlates by value.
          if (parsed.id !== undefined && parsed.id !== null) reqId = parsed.id;
        } catch {
          const m = trimmed.match(/"id"\s*:\s*("([^"]+)"|(\d+))/);
          if (m) reqId = m[2] !== undefined ? m[2] : m[3];
        }
        commandBridge.answerGetCommands(
          reqId,
          (refreshLine) => childIn.write(refreshLine),
          (answer) => clientOut.write(answer)
        );
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

      // 0.2 The subscription confirmation means omp's subagent event bus is
      //     now live: reconcile once against the authoritative snapshot so
      //     children spawned before the subscription are not invisible.
      if (
        trimmed.includes('"command":"set_subagent_subscription"') ||
        trimmed.includes('"command": "set_subagent_subscription"')
      ) {
        requestSubagentRefresh();
      }

      // 0.5 Contract doctor: arms the settle watchdog on OMP's settlement
      //     announcement, clears it on session_settled.
      doctor.observeDownstream(trimmed);

      // 1. Check settlement tracker (session_settled -> agent_settled, prompt_result)
      const settleResult = settlementTracker.handleDownstreamFrame(trimmed);
      if (settleResult.handled) {
        if (!settleResult.suppress && settleResult.emit) {
          clientOut.write(settleResult.emit);
          if (settleResult.emit.includes('"agent_settled"')) {
            doctor.noteSettled();
            // The run finalized: the next hold interval starts fresh.
            holdOpen.clear();
          }
        }
        return;
      }

      // 2. Check command bridge (catalog pushes, injected refresh responses,
      //    local command_output -> rendered turn output)
      const cmdResult = commandBridge.handleDownstreamFrame(trimmed);
      if (cmdResult.handled) {
        if (cmdResult.emit) {
          clientOut.write(cmdResult.emit);
        }
        return;
      }

      // 3. Check subagent bridge (subagent_* events, task tool-card
      //    status lines, and responses to bridge-injected ompt3-sub-* RPC)
      if (trimmed.includes('ompt3-sub-')) {
        try {
          const bridgeResp = subagentBridge.handleBridgeResponse(JSON.parse(trimmed));
          if (bridgeResp.handled) {
            if (bridgeResp.emit) clientOut.write(bridgeResp.emit);
            return;
          }
        } catch {
          // Malformed: fall through to the normal subagent path.
        }
      }
      const subResult = subagentBridge.handleDownstreamFrame(trimmed);
      if (subResult.handled) {
        if (subResult.line) clientOut.write(subResult.line);
        // A new task tool call opened, or an ambiguous child update was
        // withheld (FR14): reconcile against omp's authoritative snapshot —
        // it carries explicit parents and can attribute the withheld child.
        if (subResult.taskStarted || subResult.refreshRequested) requestSubagentRefresh();
        return;
      }

      // 4. Byte-preserving transparent passthrough (diffs, streaming tokens, dialogs, usage)
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
    subagentBridge,
    commandBridge
  };
}

/**
 * Spawns OMP child process and starts proxying standard I/O.
 * @param {string[]} ompArgs Arguments to pass to omp
 * @param {{ t3ExtensionPath?: string }} [options] When the launched T3
 *   extension is the shim-managed adapted copy, its path replaces the
 *   incoming T3_PI_MCP_EXTENSION_PATH so the extension's own tool-ownership
 *   identity check keeps matching the file omp actually loaded.
 */
function spawnAndProxy(ompArgs, options = {}) {
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
  if (options.t3ExtensionPath) {
    childEnv.T3_PI_MCP_EXTENSION_PATH = options.t3ExtensionPath;
  }
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
