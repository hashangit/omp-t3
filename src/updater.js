'use strict';

/**
 * Self-update subcommand (feature 002 US8 / FR2).
 *
 * T3 Code's provider-maintenance runner invokes `omp-t3 update --self`
 * routinely and only WARNs on failure. Historically the bridge printed an
 * unknown-option error, which surfaced as a spurious maintenance warning on
 * every launch. The default contract is therefore:
 *
 * - `update [--self]` is a successful, clearly explained no-op: it reports the
 *   detected install channel, the real install path, and the exact manual
 *   update command, then exits 0. It never mutates the install by itself —
 *   unattended global package mutation is out of scope.
 * - `update --yes` opts into performing the detected package manager's update
 *   (npm / Homebrew). A git checkout is always guidance-only: there is no
 *   package manager to delegate to.
 *
 * Channel detection is best-effort and heuristic (install methods overlap),
 * so it always reports the reasoning path, and an undetectable channel falls
 * back to "checkout" style guidance rather than guessing a package command.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** Homebrew's standard prefixes, plus $HOMEBREW_PREFIX when set. */
const BREW_PREFIXES = [
  '/opt/homebrew',
  '/home/linuxbrew/.linuxbrew'
];

/**
 * Resolves the npm global root (`npm root -g`), or null when npm is missing
 * or slow/unavailable. Only called when a channel answer needs it.
 * @returns {string | null}
 */
function npmGlobalRoot() {
  try {
    const raw = spawnSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    if (raw.status === 0 && typeof raw.stdout === 'string') {
      const root = raw.stdout.trim();
      return root && path.isAbsolute(root) ? root.replace(/[\\/]+$/, '') : null;
    }
  } catch {
    // npm absent or exec format issues -> treat as unknown
  }
  return null;
}

/**
 * Detects how this omp-t3 install is managed.
 * @param {{ execPath?: string, npmGlobalRoot?: string|null }} [options]
 *   `execPath` overrides the path to inspect (defaults to process.argv[1]);
 *   `npmGlobalRoot` short-circuits the npm discovery subprocess (for tests).
 * @returns {{ channel: 'npm' | 'homebrew' | 'checkout', realpath: string, npmGlobalRoot: string|null }}
 */
function detectInstallChannel(options = {}) {
  const inspect = options.execPath || process.argv[1] || '';
  let real = inspect;
  try {
    real = fs.realpathSync(inspect);
  } catch {
    // Broken/unresolvable path: fall back to the literal argv path.
  }

  let npmRoot = options.npmGlobalRoot !== undefined ? options.npmGlobalRoot : null;
  const isUnder = (prefix) => prefix && (real === prefix || real.startsWith(prefix + path.sep));
  const brewPrefixes = [
    process.env.HOMEBREW_PREFIX,
    ...BREW_PREFIXES
  ].filter(Boolean).map((p) => p.replace(/[\\/]+$/, ''));

  // Homebrew first: its cellars never overlap npm's global root, and this
  // avoids a pointless `npm root -g` subprocess for brew installs.
  const brewRoot = brewPrefixes.find(isUnder);
  if (brewRoot) return { channel: 'homebrew', realpath: real, npmGlobalRoot: null };

  if (npmRoot === null) npmRoot = npmGlobalRoot();
  if (npmRoot && isUnder(npmRoot)) return { channel: 'npm', realpath: real, npmGlobalRoot: npmRoot };

  return { channel: 'checkout', realpath: real, npmGlobalRoot: npmRoot };
}

/** The manual command per channel, shown both for no-op and --yes runs. */
function channelUpdateCommand(channel) {
  switch (channel) {
    case 'npm': return 'npm update -g omp-t3';
    case 'homebrew': return 'brew upgrade hashangit/omp-t3/omp-t3';
    default: return 'git -C <checkout> pull && npm install';
  }
}

/**
 * Runs the update flow and returns the lines to print plus an exit code.
 * Exit code is 0 in every no-op / guidance case — a maintenance caller
 * (`omp-t3 update --self`) must not be told the bridge is broken because
 * updating is a manual decision.
 * @param {{ run?: boolean, execPath?: string, npmGlobalRoot?: string|null, spawn?: Function }} [options]
 *   `run: true` performs the detected package-manager update (--yes). `spawn`
 *   overrides the child_process call (tests inject a fake; the real path uses
 *   spawnSync with stdio inherited).
 * @returns {{ lines: string[], exitCode: number, ran: boolean, channel: string }}
 */
function updateSelf(options = {}) {
  const { channel, realpath, npmGlobalRoot } = detectInstallChannel(options);
  const command = channelUpdateCommand(channel);
  const lines = [
    `omp-t3 self-update (install channel: ${channel})`,
    `Install path: ${realpath}`
  ];

  if (channel === 'checkout') {
    // No package manager owns this install, so even --yes stays advisory.
    lines.push(
      'This checkout is not managed by a package manager; update it manually:',
      `  ${command}`,
      'Nothing was changed.'
    );
    return { lines, exitCode: 0, ran: false, channel };
  }

  if (!options.run) {
    // No-op contract: report, advise, exit 0. T3's provider maintenance calls
    // `update --self` routinely; a quiet success (not a warning) is expected.
    lines.push(
      `This is a safe no-op. To update the package, run: ${command}`,
      'Nothing was changed.'
    );
    return { lines, exitCode: 0, ran: false, channel };
  }

  const [cmd, ...args] = command.split(/\s+/);
  const spawnFn = options.spawn || spawnSync;
  // The real path inherits stdio so the package manager's output reaches the
  // user; fakes only need to return a status.
  let res;
  try {
    res = spawnFn(cmd, args, { stdio: 'inherit' });
  } catch (err) {
    lines.push(`Could not run ${command} (${err && err.code ? err.code : 'error'}); update manually with: ${command}`);
    return { lines, exitCode: 1, ran: false, channel };
  }
  const exitCode = res.status === null || res.status === undefined ? 1 : res.status;
  if (exitCode === 0) {
    lines.push(`Updated via ${cmd}.`);
  } else {
    lines.push(`${cmd} exited ${exitCode}; update manually with: ${command}`);
  }
  return { lines, exitCode, ran: true, channel };
}

module.exports = {
  detectInstallChannel,
  channelUpdateCommand,
  updateSelf
};
