'use strict';

const fs = require('node:fs');
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

  return {
    action: 'proxy',
    ompArgs: rewritten
  };
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
  shimVersionInfo
};
