'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const pkg = require('../package.json');

/**
 * Built-in tools enabled for T3-mediated sessions when delegation
 * enforcement is on (default): omp's full default set (read, bash, edit,
 * write, grep, glob, lsp, python, notebook, browser, todo, web_search,
 * ask) MINUS `task` — the in-process subagent spawner. `computer` stays
 * excluded (disabled by default in omp). Version-pinned against the
 * supported omp releases; update when a supported release adds a tool.
 */
const DEFAULT_TOOLS = [
  'read', 'bash', 'edit', 'write', 'grep', 'glob', 'lsp', 'python',
  'notebook', 'browser', 'todo', 'web_search', 'ask'
];

/**
 * System-prompt appendix injected with delegation enforcement: routes
 * subagent-shaped work to T3's delegate_task MCP tool (isolated, openable
 * child threads) instead of the removed in-process path.
 */
const DELEGATION_POLICY = [
  '## Delegation policy (this session runs inside T3 Code)',
  '',
  'In-process subagents are disabled in this session. When the user asks for subagents, delegates, reviewers, or parallel workers — or when a task is large enough to delegate — use the T3 `delegate_task` MCP tool.',
  'Each delegation becomes an isolated, openable T3 thread with its own provider scope; results return to this thread automatically.',
  'Do your own quick, direct work (reads, searches, edits, short commands) with your regular tools instead of delegating.',
  'Do not attempt to use an in-process `task`-style subagent tool: it is intentionally unavailable here.'
].join('\n');

/**
 * Parses incoming CLI arguments and translates them for OMP execution.
 * @param {string[]} argv Raw argv slice (e.g. process.argv.slice(2))
 * @returns {{ action: string, ompArgs?: string[], options?: Record<string, any> }}
 */
function parseArgs(argv) {
  // Self-update subcommand (feature 002 US8). T3's provider maintenance calls
  // `omp-t3 update --self`; per FR2 it must NEVER surface an unknown-option
  // error, so this match runs first, the flags are conserved for the bin
  // layer to interpret, and any other position cannot shadow it.
  if (argv[0] === 'update') {
    return {
      action: 'update',
      options: {
        self: argv.includes('--self'),
        yes: argv.includes('--yes')
      }
    };
  }

  // Check for standalone helper flags
  if (argv.length === 1 || argv.length === 2) {
    if (argv.includes('--version') || argv.includes('-v')) {
      return { action: 'version' };
    }
    if (argv.includes('--help') || argv.includes('-h')) {
      return { action: 'help' };
    }
    if (argv.includes('--check')) {
      return { action: 'check' };
    }
    if (argv.includes('--setup-symlink')) {
      return { action: 'setup-symlink' };
    }
  }

  // Rewrite arguments for OMP execution
  const rewritten = [];
  let modeFound = false;
  let toolsFound = false;
  let appendPromptFound = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--mode') {
      const modeValue = argv[i + 1];
      modeFound = true;
      i++; // skip next arg

      // Always force rpc-ui mode for OMP
      rewritten.push('--mode', 'rpc-ui');
    } else if (arg.startsWith('--mode=')) {
      modeFound = true;
      rewritten.push('--mode=rpc-ui');
    } else if (arg === '--tools' || arg.startsWith('--tools=')) {
      // An explicit tools list wins: the user scoped the toolset, we keep it.
      toolsFound = true;
      rewritten.push(arg);
    } else if (arg === '--append-system-prompt' || arg.startsWith('--append-system-prompt=')) {
      // A user-provided prompt appendix is preserved and merged with ours.
      appendPromptFound = true;
      if (arg === '--append-system-prompt') {
        const value = argv[i + 1];
        rewritten.push('--append-system-prompt', `${value ?? ''}\n\n${DELEGATION_POLICY}`);
        i++; // skip next arg
      } else {
        rewritten.push(`--append-system-prompt=${arg.slice('--append-system-prompt='.length)}\n\n${DELEGATION_POLICY}`);
      }
    } else {
      rewritten.push(arg);
    }
  }

  // If no --mode was specified at all, default to rpc-ui
  if (!modeFound) {
    rewritten.unshift('--mode', 'rpc-ui');
  }

  // Delegate-enforcement (default on; OMPT3_DELEGATE_TASKS=0 opts out).
  // T3-mediated sessions must not spawn in-process subagents: the native
  // `task` tool is removed from the enabled set and the routing policy is
  // appended to the system prompt, so delegated/subagent work goes through
  // T3's delegate_task MCP tool (isolated, openable child threads). See
  // README "Delegation enforcement".
  const delegateMode = process.env.OMPT3_DELEGATE_TASKS !== '0';
  if (delegateMode) {
    if (!toolsFound) {
      rewritten.push('--tools', DEFAULT_TOOLS.join(','));
    }
    if (!appendPromptFound) {
      rewritten.push('--append-system-prompt', DELEGATION_POLICY);
    }
  }

  // Opt-in subagent concurrency cap (OMPT3_MAX_SUBAGENTS). Without the env
  // var this pushes nothing — the spawned argv stays byte-identical.
  rewritten.push(...subagentCapArgs(process.env.OMPT3_MAX_SUBAGENTS));

  return {
    action: 'proxy',
    ompArgs: rewritten
  };
}

/**
 * Cache path for the shim-managed subagent-concurrency overlay, keyed by
 * the cap value: concurrent shims with the same cap share one immutable
 * file (no last-writer-wins), different caps get different files.
 */
function subagentOverlayPath(max) {
  const cacheDir = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(cacheDir, 'omp-t3', `subagent-limits-${max}.yml`);
}

/**
 * Builds the extra omp argv for the opt-in subagent concurrency cap.
 *
 * omp natively enforces `task.maxConcurrency` — its task-tool semaphore
 * queues excess spawns until a slot frees — and derives the
 * "Max N concurrent subagents; excess queue." line of its own system
 * prompt from the same setting (live-verified against omp 18.12.3: an
 * overlay with maxConcurrency 2 made the model quote that exact line).
 * One repeatable `--config` overlay therefore both enforces the cap and
 * tells the lead agent about it; subagents are in-process tasks sharing
 * omp's single V8 heap, so bounding live children bounds the peak that
 * OOM-killed long fan-out sessions.
 *
 * Returns [] unless `rawValue` is a plain decimal positive integer
 * (`/^\d+$/` — no `0x10`, no `1e3`, no padded whitespace) that also fits
 * in a safe integer — every default
 * launch (and every invalid value, warned about on stderr with the value
 * control-character-sanitized) injects nothing. The overlay is written
 * atomically (temp + rename, so a concurrent reader never sees a torn
 * file and a pre-existing symlink at the target is replaced, not
 * followed); if the cache dir is unwritable the shim warns and launches
 * WITHOUT the cap rather than dying — availability over enforcement.
 * `--config` is repeatable in omp, so this never collides with
 * user-passed overlays.
 * @param {string|undefined} rawValue process.env.OMPT3_MAX_SUBAGENTS
 * @returns {string[]} argv items to append ('--config', <path>)
 */
function subagentCapArgs(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return [];
  if (!/^\d+$/.test(rawValue) || Number(rawValue) < 1 || !Number.isSafeInteger(Number(rawValue))) {
    const shown = String(rawValue).replace(/[\u0000-\u001f\u007f]/g, '?');
    console.error(`[omp-t3] Ignoring OMPT3_MAX_SUBAGENTS='${shown}': expected a plain positive integer (e.g. 5).`);
    return [];
  }
  const max = Number(rawValue);
  try {
    const overlayPath = subagentOverlayPath(max);
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    const tmp = `${overlayPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, `task:\n  maxConcurrency: ${max}\n`);
      fs.renameSync(tmp, overlayPath);
    } catch (writeErr) {
      fs.rmSync(tmp, { force: true });
      throw writeErr;
    }
    return ['--config', overlayPath];
  } catch (err) {
    console.error(`[omp-t3] OMPT3_MAX_SUBAGENTS=${max} ignored: cannot write the config overlay (${err.message}); launching without the cap.`);
    return [];
  }
}

/**
 * Resolves the path to the real omp executable.
 * @returns {string} Absolute path to omp binary
 */
function resolveOmpPath() {
  if (process.env.OMP_PATH && fs.existsSync(process.env.OMP_PATH)) {
    return process.env.OMP_PATH;
  }

  // Try which/where
  try {
    const whichCmd = process.platform === 'win32' ? 'where omp' : 'which omp';
    const resolved = execSync(whichCmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim().split('\n')[0];
    if (resolved && fs.existsSync(resolved)) {
      return resolved;
    }
  } catch {
    // Ignore and fallback to well-known locations
  }

  const commonLocations = [
    '/home/linuxbrew/.linuxbrew/bin/omp',
    '/opt/homebrew/bin/omp',
    '/usr/local/bin/omp',
    '/usr/bin/omp'
  ];

  for (const loc of commonLocations) {
    if (fs.existsSync(loc)) {
      return loc;
    }
  }

  throw new Error('Could not locate "omp" binary in PATH or standard directories. Please set OMP_PATH environment variable.');
}

/**
 * Derives the shim's version identity from package.json.
 *
 * Version scheme: `<pi-major>.<pi-minor>.<pi-patch>-<iteration>` (npm-legal
 * encoding of a 4th iteration level; npm rejects literal `1.3.0.1`). The first
 * three segments track the upstream Pi release this shim iteration targets;
 * the prerelease segment is the shim's own publish counter.
 *
 * T3's provider gate parses only the first `\d+\.\d+\.\d+` token of the
 * `--version` output, so we report the Pi base alone on line 1.
 * @param {string} [version] package.json version
 * @returns {{ piBase: string, iteration: string, full: string } | null}
 */
function shimVersionInfo(version = pkg.version) {
  const m = /^(\d+\.\d+\.\d+)(?:-(\d+))?$/.exec(version);
  if (!m) return null;
  return { piBase: m[1], iteration: m[2] || '0', full: version };
}

module.exports = {
  parseArgs,
  resolveOmpPath,
  shimVersionInfo,
  subagentOverlayPath,
  subagentCapArgs
};
