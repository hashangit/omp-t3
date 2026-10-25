'use strict';

// Optional real-OMP probe. Uses local fake model/MCP servers, never a paid API
// or real child. Requires a bundled T3 extension path, or the old compat cache.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseArgs, resolveOmpPath } = require('../src/cli');
const { adaptT3ExtensionArgs, GET_COMMANDS_MARKER, GET_COMMANDS_REPLACEMENT } = require('../src/extension_compat');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ompt3-policy-smoke-'));
  const calls = [];
  const frames = [];
  const allowed = { task: 'mock work', target: { providerInstanceId: 'pi', model: 'openrouter/z-ai/glm-5.3-flash', options: { thinking: 'max' } } };
  let modelTurns = 0;
  let promptChecked = false;
  let child;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', data => { body += data; });
    req.on('end', () => {
      const input = JSON.parse(body);
      if (req.url === '/mcp') {
        let result = {};
        if (input.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } };
        if (input.method === 'tools/list') result = { tools: [{ name: 'delegate_task', inputSchema: { type: 'object', additionalProperties: true } }] };
        if (input.method === 'tools/call') { calls.push(input.params); result = { content: [{ type: 'text', text: 'mock delegation accepted' }] }; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
        return;
      }
      promptChecked ||= JSON.stringify(input.messages).includes('Subagent model policy (enforced by omp-t3)');
      const chunk = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (modelTurns++ === 0) {
        const requests = [
          ['task', { agent: 'task', task: 'must be blocked' }],
          ['mcp__t3-code__delegate_task', { task: 'missing model' }],
          ['mcp__t3-code__delegate_task', { task: 'denied model', target: { model: 'openrouter/anthropic/claude-opus-4.8' } }],
          ['mcp__t3-code__delegate_task', allowed]
        ];
        res.write(chunk({ role: 'assistant', tool_calls: requests.map(([name, args], index) => ({ index, id: 'call-' + index, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }));
        res.write(chunk({}, 'tool_calls'));
      } else {
        res.write(chunk({ role: 'assistant', content: 'done' }));
        res.write(chunk({}, 'stop'));
      }
      res.end('data: [DONE]\n\n');
    });
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const sourcePath = process.env.T3_PI_MCP_EXTENSION_PATH || path.join(os.homedir(), '.cache', 'omp-t3', 'pi-t3-mcp-extension.compat.ts');
    const source = fs.readFileSync(sourcePath, 'utf8').replace(GET_COMMANDS_REPLACEMENT, () => GET_COMMANDS_MARKER);
    const original = path.join(dir, 'pi-t3-mcp-extension.ts');
    fs.writeFileSync(original, source);
    fs.mkdirSync(path.join(dir, 'agent'));
    // OMP's documented custom-provider format, docs/models.md in its repo.
    fs.writeFileSync(path.join(dir, 'agent', 'models.yml'), `providers:\n  ompt3-smoke:\n    baseUrl: http://127.0.0.1:${port}/v1\n    api: openai-completions\n    apiKey: mock\n    models:\n      - id: mock\n        name: Mock\n        contextWindow: 128000\n        maxTokens: 4000\n`);
    const parsed = parseArgs(['--mode', 'rpc', '--no-session', '--no-extensions', '--extension', original, '--provider', 'ompt3-smoke', '--model', 'mock', '--tools', 'task']);
    const adapted = await adaptT3ExtensionArgs(parsed.ompArgs, { cachePath: path.join(dir, 'compat.ts') });
    let stderr = '';
    await new Promise((resolve, reject) => {
      child = spawn(resolveOmpPath(), adapted.args, {
        cwd: dir, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PI_CODING_AGENT_DIR: path.join(dir, 'agent'), T3_MCP_URL: `http://127.0.0.1:${port}/mcp`, T3_MCP_BEARER_TOKEN: 'mock', T3_PI_MCP_EXTENSION_PATH: adapted.extensionPath }
      });
      const timer = setTimeout(() => reject(new Error('OMP smoke timed out: ' + stderr)), 15000);
      let buffered = '', sent = false;
      child.stderr.on('data', data => { stderr += data; });
      child.stdout.on('data', data => {
        buffered += data;
        let newline;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          let frame;
          try { frame = JSON.parse(line); } catch { continue; }
          frames.push(frame);
          if (!sent && frame.type === 'ready') {
            sent = true;
            child.stdin.write(JSON.stringify({ type: 'prompt', id: 'smoke', message: 'Exercise model restrictions.' }) + '\n');
          }
          if (frame.type === 'session_settled') { clearTimeout(timer); resolve(); }
        }
      });
      child.once('error', err => { clearTimeout(timer); reject(err); });
      child.once('close', code => { clearTimeout(timer); reject(new Error(`OMP exited ${code}: ${stderr}`)); });
    });
    assert.equal(stderr, '');
    assert.equal(promptChecked, true, 'the model must receive the policy in its prompt');
    const results = frames.filter(frame => frame.type === 'tool_execution_end');
    for (const id of ['call-0', 'call-1', 'call-2']) {
      const result = results.find(frame => frame.toolCallId === id);
      assert.equal(result?.isError, true, id + ' must be blocked');
      assert.match(JSON.stringify(result.result), /Subagent model policy/);
    }
    assert.equal(results.find(frame => frame.toolCallId === 'call-3')?.isError, false);
    assert.deepEqual(calls, [{ name: 'delegate_task', arguments: allowed }], 'only the allowed request may reach MCP, with its target and options intact');
    console.log('PASS: real OMP received the policy prompt, blocked native/missing/denied models, and forwarded only the allowed delegation with options intact.');
  } finally {
    if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') throw err; } }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
