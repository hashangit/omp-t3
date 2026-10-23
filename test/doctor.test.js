'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ContractDoctor, statePath } = require('../src/doctor.js');

function withTempStateHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-t3-state-'));
  const original = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = dir;
  try {
    return fn(dir);
  } finally {
    if (original === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeFakeOmp(dir, version) {
  const script = path.join(dir, 'fake-omp');
  fs.writeFileSync(script, `#!/bin/sh\necho "omp/${version}"\n`);
  fs.chmodSync(script, 0o755);
  return script;
}

test('ContractDoctor records last known good on clean settle', () => {
  withTempStateHome((dir) => {
    const omp = makeFakeOmp(dir, '18.11.3');
    const doctor = new ContractDoctor({ ompPath: omp, shimVersion: '0.1.0', issuesEnabled: false });
    doctor.noteSettled();
    const state = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    assert.equal(state.lastGood.ompVersion, '18.11.3');
    assert.equal(state.lastGood.shimVersion, '0.1.0');
  });
});

test('ContractDoctor synthesizes agent_settled when promised settle never arrives', async () => {
  await withTempStateHome(async () => {
    const doctor = new ContractDoctor({ ompPath: null, ompVersion: '18.11.3', watchdogMs: 20, issuesEnabled: false });
    let synth = null;
    doctor.onSynth = (line) => { synth = line; };
    doctor.observeDownstream(JSON.stringify({ type: 'prompt_result', agentInvoked: true, sessionSettled: true, status: 'completed' }));
    assert.equal(synth, null); // not yet
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(synth, 'watchdog must fire');
    const parsed = JSON.parse(synth);
    assert.equal(parsed.type, 'agent_settled');
    assert.equal(parsed.aborted, false);
    doctor.stop();
  });
});

test('ContractDoctor cancels watchdog when session_settled arrives', async () => {
  await withTempStateHome(async () => {
    const doctor = new ContractDoctor({ ompPath: null, ompVersion: '18.11.3', watchdogMs: 20, issuesEnabled: false });
    let synth = null;
    doctor.onSynth = (line) => { synth = line; };
    doctor.observeDownstream(JSON.stringify({ type: 'prompt_result', agentInvoked: true, sessionSettled: true, status: 'completed' }));
    doctor.observeDownstream('{"type":"session_settled"}');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(synth, null);
    doctor.stop();
  });
});

test('ContractDoctor reports drift with rollback guidance and rate-limits', () => {
  withTempStateHome(() => {
    const doctor = new ContractDoctor({ ompPath: null, ompVersion: '18.12.0', issuesEnabled: false });
    doctor.state.lastGood = { ompVersion: '18.11.3', shimVersion: '0.1.0', at: Date.now() };

    const writes = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    try {
      doctor.report({ signature: 'settle-missing:18.12.0', side: 'omp', title: 'T', detail: 'D', sample: {} });
      doctor.report({ signature: 'settle-missing:18.12.0', side: 'omp', title: 'T', detail: 'D', sample: {} });
    } finally {
      process.stderr.write = original;
    }
    const text = writes.join('');
    assert.ok(text.includes('contract changed'), 'must tell the user the contract changed');
    assert.ok(text.includes('18.11.3'), 'must include the last known good version');
    assert.match(text, /roll back/i, 'must include rollback guidance');
    assert.ok(text.includes('hashangit/omp-t3'), 'must reference the issue tracker');
    // Rate limit: second identical report within a day only writes once extra... verify via state
    assert.ok(Object.keys(doctor.state.issuesFiled).includes('settle-missing:18.12.0'));
  });
});

// --- Feature 002 FR5: in-thread drift notices ---

test('watchdog writes the drift notice in-thread BEFORE the synthesized settle', async () => {
  await withTempStateHome(async () => {
    const doctor = new ContractDoctor({ ompPath: null, ompVersion: '18.11.3', watchdogMs: 20, issuesEnabled: false });
    const out = [];
    doctor.onNotice = (line) => out.push({ kind: 'notice', line });
    doctor.onSynth = (line) => out.push({ kind: 'settle', line });
    doctor.observeDownstream(JSON.stringify({ type: 'prompt_result', agentInvoked: true, sessionSettled: true, status: 'completed' }));
    await new Promise((r) => setTimeout(r, 60));
    doctor.stop();

    assert.equal(out.length, 2);
    assert.equal(out[0].kind, 'notice');
    const frame = JSON.parse(out[0].line);
    assert.equal(frame.type, 'extension_ui_request');
    assert.equal(frame.method, 'notify');
    assert.ok(frame.message.includes('session_settled'), 'notice names the drift');

    assert.equal(out[1].kind, 'settle');
    assert.equal(JSON.parse(out[1].line).type, 'agent_settled');
  });
});

test('drift notice shares the 24h rate-limit ledger (option passes only from the watchdog)', () => {
  withTempStateHome(() => {
    const doctor = new ContractDoctor({ ompPath: null, ompVersion: '18.12.0', issuesEnabled: false });
    const notices = [];
    doctor.onNotice = (line) => notices.push(JSON.parse(line));

    const writes = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    try {
      const drift = { signature: 'settle-missing:18.12.0', side: 'omp', title: 'session_settled vanished', detail: 'D', sample: {} };
      doctor.report(drift, { notify: true });
      assert.equal(notices.length, 1);
      assert.equal(notices[0].method, 'notify');
      assert.equal(notices[0].notifyType, 'info');
      assert.ok(notices[0].message.includes('session_settled vanished'));
      assert.equal(writes.length, 1, 'the stderr rollback guidance still prints');

      // Same signature within 24h: stderr still logs, no second in-thread notice
      doctor.report(drift, { notify: true });
      assert.equal(notices.length, 1);
      assert.equal(writes.length, 2);
    } finally {
      process.stderr.write = original;
    }
  });
});

test('discovery-failure reports never emit in-thread notices', () => {
  withTempStateHome(() => {
    const doctor = new ContractDoctor({ ompPath: null, ompVersion: '18.12.0', issuesEnabled: false });
    const notices = [];
    doctor.onNotice = (line) => notices.push(line);
    doctor.reportDiscoveryFailure(new Error('omp models --json exited 1'));
    assert.equal(notices.length, 0, 'no active turn exists during discovery: consumer renders nothing');
  });
});
