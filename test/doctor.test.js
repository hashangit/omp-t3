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
