'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ModelCatalogManager } = require('../src/model_catalog.js');

test('ModelCatalogManager prunes models safely and keeps required fields', () => {
  const manager = new ModelCatalogManager();

  const rawModels = [
    {
      provider: 'zai',
      id: 'glm-5.3-flash',
      selector: 'zai/glm-5.3-flash',
      name: 'GLM 5.3 Flash',
      contextWindow: 1048576,
      maxTokens: 131072,
      reasoning: true,
      thinking: ['low', 'high', 'max'],
      cost: { input: 0.1, output: 0.2 },
      pricingStatus: 'fixed'
    },
    {
      provider: 'anthropic',
      id: 'claude-3-5-sonnet',
      selector: 'anthropic/claude-3-5-sonnet',
      name: 'Claude 3.5 Sonnet',
      contextWindow: 200000,
      maxTokens: 8192,
      reasoning: true,
      thinking: ['high'],
      cost: { input: 3, output: 15 },
      pricingStatus: 'fixed'
    }
  ];

  const pruned = manager.pruneModels(rawModels);
  assert.equal(pruned.length, 2);

  const m1 = pruned[0];
  assert.equal(m1.id, 'glm-5.3-flash');
  assert.equal(m1.name, 'GLM 5.3 Flash');
  assert.equal(m1.provider, 'zai');
  assert.equal(m1.contextWindow, 1048576);
  assert.equal(m1.maxTokens, 131072);
  assert.equal(m1.reasoning, true);
  assert.deepEqual(m1.thinkingLevelMap, {
    off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max'
  });
  assert.equal(m1.thinking, undefined); // boolean form is ignored by T3; map emitted instead
  assert.equal(m1.cost, undefined); // pruned
  assert.equal(m1.pricingStatus, undefined); // pruned
});

test('ModelCatalogManager strips redundant provider prefix from model id', () => {
  const manager = new ModelCatalogManager();
  const rawModels = [
    {
      provider: 'openrouter',
      id: 'openrouter/deepseek/deepseek-v4.1-flash',
      selector: 'openrouter/deepseek/deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash'
    },
    {
      provider: 'openrouter',
      id: 'deepseek/deepseek-v4.1-flash',
      selector: 'openrouter/deepseek/deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash'
    }
  ];

  const pruned = manager.pruneModels(rawModels);
  assert.equal(pruned[0].id, 'deepseek/deepseek-v4.1-flash');
  assert.equal(pruned[0].provider, 'openrouter');
  assert.equal(pruned[1].id, 'deepseek/deepseek-v4.1-flash');
  assert.equal(pruned[1].provider, 'openrouter');
});

test('ModelCatalogManager creates valid response payload under frame limit', () => {
  const manager = new ModelCatalogManager();
  const rawModels = Array.from({ length: 100 }, (_, i) => ({
    provider: 'provider' + i,
    id: 'model-' + i,
    name: 'Model ' + i,
    contextWindow: 128000,
    maxTokens: 8192,
    reasoning: true,
    thinking: ['low', 'high'],
    cost: { input: 1, output: 2 }
  }));

  manager.setCachedModels(manager.pruneModels(rawModels));

  const responseJson = manager.createModelResponse('req-123');
  const parsed = JSON.parse(responseJson);

  assert.equal(parsed.id, 'req-123');
  assert.equal(parsed.type, 'response');
  assert.equal(parsed.command, 'get_available_models');
  assert.equal(parsed.success, true);
  assert.equal(parsed.models.length, 100);

  const payloadSize = Buffer.byteLength(responseJson, 'utf8');
  assert.ok(payloadSize < 500 * 1024, `Payload size ${payloadSize} should be under 500KB`);
});

test('ModelCatalogManager intercepts get_available_models frame', () => {
  const manager = new ModelCatalogManager();
  manager.setCachedModels([
    { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', provider: 'zai' }
  ]);

  const reqLine = '{"type": "get_available_models", "id": "test-req"}';
  const handled = manager.handleUpstreamFrame(reqLine);

  assert.equal(handled.intercepted, true);
  assert.ok(handled.response);
  const parsed = JSON.parse(handled.response);
  assert.equal(parsed.id, 'test-req');
  assert.equal(parsed.models[0].name, 'GLM 5.3 Flash');
});

test('ModelCatalogManager persists discovered models and falls back to them on failure', () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-t3-models-'));
  const original = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cacheDir;
  try {
    // 1. Successful discovery persists the pruned catalog
    const manager = new ModelCatalogManager();
    const fakeOmp = path.join(cacheDir, 'fake-omp');
    fs.writeFileSync(fakeOmp, '#!/bin/sh\necho \'{"models":[{"provider":"zai","id":"glm-x","name":"GLM X","contextWindow":100,"thinking":["low","high"]}]}\'\n');
    fs.chmodSync(fakeOmp, 0o755);
    const models = manager.getModels(fakeOmp);
    assert.equal(models.length, 1);
    assert.equal(models[0].id, 'glm-x');
    assert.equal(manager.servingStale, false);
    const persisted = JSON.parse(fs.readFileSync(path.join(cacheDir, 'omp-t3', 'models.json'), 'utf8'));
    assert.equal(persisted.models.length, 1);

    // 2. Fresh manager (no memory), broken omp -> serves persisted list, flagged stale, stderr notice
    const writes = [];
    const origErr = process.stderr.write;
    process.stderr.write = (c) => { writes.push(String(c)); return true; };
    const manager2 = new ModelCatalogManager();
    try {
      const stale = manager2.getModels('/nonexistent/omp');
      assert.equal(stale.length, 1);
      assert.equal(stale[0].id, 'glm-x');
      assert.equal(manager2.servingStale, true);
      const resp = JSON.parse(manager2.createModelResponse('r1', '/nonexistent/omp'));
      assert.equal(resp.stale, true);
    } finally {
      process.stderr.write = origErr;
    }
    assert.ok(writes.join('').includes('persisted catalog'), 'must tell the user the list is stale');

    // 3. Nothing persisted anywhere -> static fallback + stderr notice (no crash)
    process.env.XDG_CACHE_HOME = path.join(cacheDir, 'empty');
    const manager3 = new ModelCatalogManager();
    const fallback = manager3.getModels('/nonexistent/omp');
    assert.ok(fallback.length >= 1);
    assert.equal(manager3.servingStale, true);
  } finally {
    if (original === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = original;
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});
