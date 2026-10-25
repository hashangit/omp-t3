'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

// Keep this factory self-contained: the extension adapter embeds the same
// implementation in T3's TypeScript bridge, without runtime imports.
function createSubagentPolicy(env = process.env) {
  const read = (name, defaults) => {
    if (env[name] === undefined) return defaults;
    if (env[name].trim() === '') return [];
    const values = env[name].split(',').map(value => value.trim());
    if (values.some(value => !value || /\s|[\u0000-\u001f\u007f]/.test(value))) {
      throw new Error(`${name} must contain comma-separated model IDs or * patterns, not display names or empty entries.`);
    }
    return [...new Set(values)];
  };
  const allowed = read('OMPT3_SUBAGENT_ALLOWED_MODELS', [
    'glm-5.3-flash', 'gemini-3.8-flash', 'deepseek-v4.1-flash'
  ]);
  const disallowed = read('OMPT3_SUBAGENT_DISALLOWED_MODELS', [
    'gpt-*sol*', '*opus*', 'glm-5.3', 'glm-5.3:*'
  ]);
  const active = allowed.length > 0 || disallowed.length > 0;
  const compile = pattern => {
    const source = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return { qualified: pattern.includes('/'), regex: new RegExp(`^${source}$`, 'i') };
  };
  const allowRules = allowed.map(compile);
  const denyRules = disallowed.map(compile);
  const matches = (rules, model) => rules.some(({ qualified, regex }) =>
    regex.test(qualified ? model : model.slice(model.lastIndexOf('/') + 1)));
  const summary = `Allowed: ${allowed.join(', ') || 'any explicit model'}. Disallowed: ${disallowed.join(', ') || 'none'}. Disallowed rules take precedence.`;
  const checkModel = model => {
    if (!active) return null;
    if (typeof model !== 'string' || !model || model.trim() !== model || /\s|[\u0000-\u001f\u007f]/.test(model)) {
      return `Subagent model policy: set target.model explicitly to an allowed catalog model ID; parent-model inheritance is blocked. ${summary}`;
    }
    if (matches(denyRules, model) || (allowed.length && !matches(allowRules, model))) {
      return `Subagent model policy rejected ${JSON.stringify(model)}. ${summary} Retry delegate_task with an allowed model.`;
    }
    return null;
  };
  const checkTool = (name, params) => {
    if (!active) return null;
    if (name === 'task') {
      return 'Subagent model policy: native task is blocked because its resolved model cannot be checked here. Use T3 delegate_task with an explicit allowed target.model.';
    }
    if (/^(?:mcp__t3[-_]code__)?delegate_task$/.test(name)) return checkModel(params?.target?.model);
    return null;
  };
  const prompt = active ? [
    '## Subagent model policy (enforced by omp-t3)',
    summary,
    'These restrictions apply to subagents only; the parent model is unchanged.',
    'Use T3 delegate_task for subagents. Native task is blocked while this policy is active.',
    'Before delegating, use orchestrator_capabilities to find available model IDs. Set target.model explicitly on every call, including nested delegations; never inherit the parent model.',
    'Rules match model IDs case-insensitively. Unqualified rules match the final /-separated model name; qualified rules match the full ID. Only * is a wildcard. Use the catalog ID, not a display name.',
    'Prohibited or omitted models return an error before delegation. Retry with an allowed model; do not bypass the policy through another tool or command.'
  ].join('\n') : '';
  return { allowed, disallowed, active, checkModel, checkTool, prompt };
}

function policyRuntimeSource() {
  return `const ompt3SubagentPolicy = (${createSubagentPolicy.toString()})(process.env);`;
}

// A separate hook also covers native task and configured MCP aliases, even if
// the launch has no bundled T3 bridge. Content-keyed paths avoid concurrent
// installations overwriting an extension that another session is loading.
function subagentPolicyArgs(policy) {
  if (!policy.active) return [];
  const source = [
    policyRuntimeSource(),
    'export default function ompT3SubagentPolicy(pi) {',
    '  pi.on("tool_call", (event) => {',
    '    const reason = ompt3SubagentPolicy.checkTool(event.toolName, event.input);',
    '    if (reason) return { block: true, reason };',
    '  });',
    '}'
  ].join('\n');
  const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
  const cacheDir = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const file = path.join(cacheDir, 'omp-t3', `subagent-policy-${hash}.ts`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== source) {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, source);
      fs.renameSync(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  return ['--extension', file];
}

module.exports = { createSubagentPolicy, policyRuntimeSource, subagentPolicyArgs };
