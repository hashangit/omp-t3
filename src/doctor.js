'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exec, execFile } = require('node:child_process');

const ISSUE_REPO = 'hashangit/omp-t3';
const ISSUE_RATE_LIMIT_MS = 24 * 60 * 60 * 1000;
const SETTLE_WATCHDOG_MS = 15_000; // omp writes session_settled promptly after a settled prompt_result

function statePath() {
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'omp-t3', 'contract-state.json');
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return { lastGood: null, issuesFiled: {} };
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
  } catch {
    // State is best-effort; never block frame flow on it
  }
}
/**
 * Watches the OMP<->T3 contract at runtime. On every cleanly settled turn it
 * records the running OMP/shim versions as "last known good". If OMP breaks a
 * contract promise (e.g. stops emitting session_settled after announcing it),
 * or model discovery dies, it tells the user which side changed and how to
 * roll back, and files a rate-limited GitHub issue with a sanitized payload.
 */
class ContractDoctor {

  constructor(options = {}) {
    this.ompPath = options.ompPath || null;
    this.ompVersion = options.ompVersion || null;
    this.shimVersion = options.shimVersion || null;
    this.watchdogMs = options.watchdogMs || SETTLE_WATCHDOG_MS;
    this.issuesEnabled = options.issuesEnabled !== false;
    this.state = loadState();
    this.settleTimer = null;
    this.pendingSettle = null;
  }

  /** Wires runtime context after the omp child is resolved. */
  init(ompPath, ompVersion, shimVersion) {
    this.ompPath = ompPath;
    this.ompVersion = ompVersion || this.ompVersion;
    this.shimVersion = shimVersion || this.shimVersion;
  }

  currentOmpVersion() {
    if (this.ompVersion) return this.ompVersion;
    if (!this.ompPath) return null;
    try {
      const { execFileSync } = require('node:child_process');
      const raw = execFileSync(this.ompPath, ['--version'], { encoding: 'utf8', timeout: 4000, stdio: ['pipe', 'pipe', 'ignore'] });
      const m = /\bv?(\d+\.\d+\.\d+)\b/.exec(raw);
      this.ompVersion = m ? m[1] : null;
    } catch {
      this.ompVersion = null;
    }
    return this.ompVersion;
  }

  /**
   * Records the running versions as the last known good configuration.
   * Called whenever a turn settles cleanly.
   */
  noteSettled() {
    const ompVersion = this.currentOmpVersion();
    if (!ompVersion) return;
    this.state.lastGood = {
      ompVersion,
      shimVersion: this.shimVersion || null,
      at: Date.now()
    };
    saveState(this.state);
  }

  /**
   * Observes a downstream frame. Arms the settle watchdog when OMP announces
   * the session is already done (prompt_result.sessionSettled === true) and
   * confirms it when session_settled arrives. Returns a synthesized
   * agent_settled line if the watchdog fired (contract drift).
   * @param {string} line Raw downstream JSON line
   * @returns {{ settle?: string }}
   */
  observeDownstream(line) {
    if (line.includes('"prompt_result"')) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'prompt_result' && parsed.agentInvoked === true && parsed.sessionSettled === true) {
          this.pendingSettle = { status: parsed.status || 'completed' };
          clearTimeout(this.settleTimer);
          this.settleTimer = setTimeout(() => this.onSettleWatchdog(), this.watchdogMs);
        }
      } catch {
        // Ignore parse failures here; settlement.js owns the frame
      }
    } else if (line.includes('"session_settled"')) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
      this.pendingSettle = null;
    }
    return {};
  }

  onSettleWatchdog() {
    const status = this.pendingSettle ? this.pendingSettle.status : 'completed';
    this.pendingSettle = null;
    this.settleTimer = null;
    this.report({
      signature: `settle-missing:${this.currentOmpVersion() || 'unknown'}`,
      side: 'omp',
      title: `OMP ${this.currentOmpVersion() || '?'} stopped emitting session_settled after a settled prompt_result`,
      detail: 'T3 Code only finalizes turns on Pi agent_settled, which omp-t3 synthesizes from OMP session_settled. OMP announced settlement (prompt_result with sessionSettled=true) but never wrote the session_settled frame, so turns would hang forever. omp-t3 synthesized the settle frame as a stopgap.',
      sample: { expected: 'session_settled within 15s of prompt_result {agentInvoked:true, sessionSettled:true}' }
    });
    const settleLine = JSON.stringify({ type: 'agent_settled', aborted: status === 'aborted' }) + '\n';
    if (typeof this.onSynth === 'function') this.onSynth(settleLine);
    return settleLine;
  }

  /**
   * Reports a model-discovery contract failure (omp models --json shape or
   * exit changed). Called from the model catalog path.
   * @param {Error} err
   */
  reportDiscoveryFailure(err) {
    const reason = (err && (err.code || err.name)) || 'unknown';
    this.report({
      signature: `discovery-failed:${this.currentOmpVersion() || 'unknown'}:${reason}`,
      side: 'omp',
      title: `Model discovery failed with OMP ${this.currentOmpVersion() || '?'}`,
      detail: `omp models --json no longer produces the catalog shape omp-t3 translates (${err && err.message ? err.message : reason}). T3's model selector will fall back to custom models only.`,
      sample: { error: String((err && err.message) || reason).slice(0, 300) }
    });
  }

  /**
   * Reports a drift, shows rollback guidance on stderr, and files a GitHub
   * issue at most once per signature per day.
   * @param {{ signature: string, side: string, title: string, detail: string, sample: object }} drift
   */
  report(drift) {
    const lastGood = this.state.lastGood;
    const rolledBackFrom = lastGood && lastGood.ompVersion !== this.currentOmpVersion() ? lastGood.ompVersion : null;

    const lines = [
      '',
      '============================================================',
      'omp-t3: underlying contract changed!',
      `  Drift: ${drift.title}`,
      `  Side:  ${drift.side === 'omp' ? 'OMP (the provider binary) changed its RPC contract' : 'T3 Code changed the Pi provider contract'}`,
      lastGood
        ? `  Last known good: omp/${lastGood.ompVersion} with omp-t3 shim ${lastGood.shimVersion || '?'}, recorded ${new Date(lastGood.at).toISOString()}`
        : '  Last known good: none recorded yet',
      rolledBackFrom
        ? `  ROLL BACK OMP to the previously working version: npm install -g omp@${rolledBackFrom} (or brew/pip equivalent you installed it with)`
        : '  Roll back the side that changed to your previously installed version.',
      '  An issue with diagnostics will be filed at https://github.com/' + ISSUE_REPO + '/issues (once per day per drift).',
      '============================================================'
    ];
    process.stderr.write(lines.join('\n') + '\n');

    const now = Date.now();
    const lastFiled = this.state.issuesFiled[drift.signature] || 0;
    if (now - lastFiled < ISSUE_RATE_LIMIT_MS) return;
    this.state.issuesFiled[drift.signature] = now;
    saveState(this.state);
    if (this.issuesEnabled) this.fileIssue(drift, lastGood, rolledBackFrom);
  }

  fileIssue(drift, lastGood, rolledBackFrom) {
    const body = [
      `## Contract drift: ${drift.signature}`,
      '',
      `**Side:** ${drift.side}`,
      `**Title:** ${drift.title}`,
      '',
      `**Detail:** ${drift.detail}`,
      '',
      '| | version |',
      '|---|---|',
      `| omp-t3 shim | ${this.shimVersion || '?'} |`,
      `| OMP (current) | ${this.currentOmpVersion() || '?'} |`,
      `| OMP (last known good) | ${lastGood ? lastGood.ompVersion : 'none'} |`,
      `| Node | ${process.version} |`,
      `| Platform | ${os.platform()} ${os.release()} |`,
      '',
      '**Sample (sanitized, no user content):**',
      '```json',
      JSON.stringify(drift.sample, null, 2).slice(0, 2000),
      '```',
      rolledBackFrom ? `\nUser advised to roll back OMP to ${rolledBackFrom}.` : ''
    ].join('\n');
    const title = `Contract drift (${drift.side}): ${drift.signature}`;

    // Prefer gh (uses the user's existing auth); fall back to a prefilled URL.
    exec('gh auth status', { timeout: 5000 }, (err) => {
      if (err) {
        const url = `https://github.com/${ISSUE_REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
        process.stderr.write(`omp-t3: could not auto-file the issue (gh CLI unavailable/unauthenticated).\nFile it manually: ${url}\n`);
        return;
      }
      execFile('gh', ['issue', 'create', '--repo', ISSUE_REPO, '--title', title, '--body', body], { timeout: 30000 }, (err2, stdout) => {
        if (err2) {
          process.stderr.write(`omp-t3: failed to file the GitHub issue: ${err2.message}\n`);
        } else {
          process.stderr.write(`omp-t3: filed contract-drift issue: ${String(stdout).trim()}\n`);
        }
      });
    });
  }

  stop() {
    clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }
}

module.exports = { ContractDoctor, statePath };