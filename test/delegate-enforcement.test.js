'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs } = require('../src/cli.js');

// --- Delegation enforcement (default on; OMPT3_DELEGATE_TASKS=0 opts out) ---

test('enforcement: default launch injects the task-free tools list and the policy', () => {
  const { ompArgs } = parseArgs(['--mode', 'rpc']);
  const toolsIdx = ompArgs.indexOf('--tools');
  assert.notEqual(toolsIdx, -1, '--tools injected');
  const list = ompArgs[toolsIdx + 1].split(',');
  assert.equal(list.includes('task'), false, 'native task tool removed');
  assert.equal(list.includes('computer'), false, 'computer stays at its omp default (off)');
  for (const t of ['read', 'bash', 'edit', 'write', 'grep', 'glob', 'todo', 'web_search']) {
    assert.equal(list.includes(t), true, `${t} stays enabled`);
  }
  const policyIdx = ompArgs.indexOf('--append-system-prompt');
  assert.notEqual(policyIdx, -1, 'policy appended');
  assert.ok(ompArgs[policyIdx + 1].includes('delegate_task'), 'policy routes to delegate_task');
});

test('enforcement: byte-parity restored when OMPT3_DELEGATE_TASKS=0', () => {
  process.env.OMPT3_DELEGATE_TASKS = '0';
  try {
    const { ompArgs } = parseArgs(['--mode', 'rpc', '--session', 'abc']);
    assert.deepEqual(ompArgs, ['--mode', 'rpc-ui', '--session', 'abc']);
  } finally {
    delete process.env.OMPT3_DELEGATE_TASKS;
  }
});

test('enforcement: an explicit --tools list wins over the injected one', () => {
  const { ompArgs } = parseArgs(['--tools', 'read,bash', '--mode', 'rpc']);
  const lists = ompArgs.filter((a) => a === 'read,bash');
  assert.equal(lists.length, 1, 'user list kept, no injected list');
  assert.equal(ompArgs.includes('read,bash,edit,write,grep,glob,lsp,python,notebook,browser,todo,web_search,ask'), false);
});

test('enforcement: --tools=<value> form also suppresses injection', () => {
  const { ompArgs } = parseArgs(['--tools=read', '--mode', 'rpc']);
  const toolFlags = ompArgs.filter((a) => a.startsWith('--tools'));
  assert.equal(toolFlags.length, 1, 'exactly one tools flag');
  assert.equal(toolFlags[0], '--tools=read', 'user list kept verbatim');
});

test('enforcement: a user appendix is preserved and the policy is merged into one flag', () => {
  const { ompArgs } = parseArgs(['--append-system-prompt', 'be terse', '--mode', 'rpc']);
  const idx = ompArgs.indexOf('--append-system-prompt');
  assert.notEqual(idx, -1);
  const value = ompArgs[idx + 1];
  assert.ok(value.startsWith('be terse'), 'user appendix first');
  assert.ok(value.includes('Delegation policy'), 'policy merged after it');
  assert.equal(ompArgs.filter((a) => a === '--append-system-prompt').length, 1, 'single flag');
});

test('enforcement: --append-system-prompt=<value> form is merged too', () => {
  const { ompArgs } = parseArgs(['--append-system-prompt=be terse', '--mode', 'rpc']);
  const prompts = ompArgs.filter((a) => a.startsWith('--append-system-prompt'));
  assert.equal(prompts.length, 1, 'exactly one appendix flag');
  const value = prompts[0].slice('--append-system-prompt='.length);
  assert.ok(value.startsWith('be terse'), 'user appendix preserved');
  assert.ok(value.includes('Delegation policy'), 'policy merged');
});

test('enforcement: composes with the concurrency cap and mode rewrite', () => {
  process.env.OMPT3_MAX_SUBAGENTS = '5';
  try {
    const { ompArgs } = parseArgs(['--mode', 'rpc']);
    assert.ok(ompArgs.includes('--config'), 'cap overlay still injected');
    assert.ok(ompArgs.includes('--tools'), 'tools list still injected');
    assert.ok(ompArgs.includes('--append-system-prompt'), 'policy still injected');
  } finally {
    delete process.env.OMPT3_MAX_SUBAGENTS;
  }
});
