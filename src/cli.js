'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const pkg = require('../package.json');

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
    } else {
      rewritten.push(arg);
    }
  }

  // If no --mode was specified at all, default to rpc-ui
  if (!modeFound) {
    rewritten.unshift('--mode', 'rpc-ui');
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
 * Cache path for the shim-managed subagent-concurrency overlay
 * (same XDG pattern as the model catalog cache).
 */
function subagentOverlayPath() {
  const cacheDir = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(cacheDir, 'omp-t3', 'subagent-limits.yml');
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
 * Returns [] unless `rawValue` is a positive integer — every default
 * launch (and every invalid value, warned about on stderr) injects
 * nothing. `--config` is repeatable in omp, so this never collides with
 * user-passed overlays.
 * @param {string|undefined} rawValue process.env.OMPT3_MAX_SUBAGENTS
 * @returns {string[]} argv items to append ('--config', <path>)
 */
function subagentCapArgs(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return [];
  const max = Number(rawValue);
  if (!Number.isInteger(max) || max < 1) {
    console.error(`[omp-t3] Ignoring OMPT3_MAX_SUBAGENTS='${rawValue}': expected a positive integer.`);
    return [];
  }
  const overlayPath = subagentOverlayPath();
  fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
  fs.writeFileSync(overlayPath, `task:\n  maxConcurrency: ${max}\n`);
  return ['--config', overlayPath];
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
