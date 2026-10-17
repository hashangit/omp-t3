'use strict';

/**
 * Adapts T3 Code's bundled pi extension for OMP at launch time.
 *
 * T3 spawns the shim with `--extension <cache>/pi-t3-mcp-extension.ts` and
 * env `T3_PI_MCP_EXTENSION_PATH` pointing at the same file. That extension's
 * input handler resolves `$name` skill mentions through
 * `command.sourceInfo.path` (Pi's command shape). OMP's in-process command
 * objects carry the same location under `command.path` instead, so on OMP the
 * handler throws "undefined is not an object" on every `$name` prompt and the
 * skill body is never inlined.
 *
 * The wire-level `get_commands` answer cannot fix this: the extension reads
 * OMP's in-process list, not the shim's RPC response. The fix is to launch a
 * shim-managed copy of the extension whose source is identical except that
 * its `getCommands()` view projects OMP's `command.path` into
 * `sourceInfo.path`. `T3_PI_MCP_EXTENSION_PATH` is repointed at the copy so
 * the extension's own tool-ownership identity check (it resolves the loaded
 * extension's path against that env var) keeps matching.
 *
 * The copy lives under ~/.cache/omp-t3/ and is rewritten whenever the
 * transformed output differs (T3 refreshes its own cache file on updates).
 * If the upstream source drifts (marker not found exactly once), the original
 * file is passed through unchanged with a stderr warning: behavior then
 * matches stock OMP ($name crash) instead of silently running stale code.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const T3_EXTENSION_BASENAME = 'pi-t3-mcp-extension.ts';

// Exact statement in T3's extension (verified against the T3 alpha cache,
// 2026-10-17). Rewritten so every skill command OMP serves — including
// project-level skills, `.omp/skills`, and skills whose frontmatter name
// differs from their folder — exposes Pi's expected `sourceInfo.path`.
const GET_COMMANDS_MARKER =
  'const commands = pi.getCommands().filter((command) => command.source === "skill");';
const GET_COMMANDS_REPLACEMENT = [
  'const commands = pi.getCommands()',
  '    .filter((command) => command.source === "skill")',
  '    .map((command) => typeof command.path === "string" && command.sourceInfo === undefined',
  '      ? { ...command, sourceInfo: { path: command.path } }',
  '      : command);'
].join('\n');

function defaultCachePath() {
  return path.join(os.homedir(), '.cache', 'omp-t3', 'pi-t3-mcp-extension.compat.ts');
}

/**
 * Rewrites T3 extension argv entries to the shim-managed adapted copy.
 * Only entries whose file basename is T3's extension are touched; user
 * extensions pass through untouched.
 * @param {string[]} ompArgs - translated args destined for omp.
 * @param {{ cachePath?: string, log?: (message: string) => void }} [options]
 * @returns {Promise<{ args: string[], extensionPath: string|null }>}
 *   `args` is the argv to spawn; `extensionPath` is the adapted copy's path
 *   (to be placed in the child's T3_PI_MCP_EXTENSION_PATH), or null when
 *   nothing was adapted.
 */
async function adaptT3ExtensionArgs(ompArgs, options = {}) {
  const cachePath = options.cachePath || defaultCachePath();
  const log = options.log || ((message) => console.error(`[omp-t3] ${message}`));
  const args = ompArgs.slice();
  let extensionPath = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let value = null;
    let valueIndex = null;
    let tokenPrefix = '';
    if (arg === '--extension' || arg === '-e') {
      value = args[i + 1];
      valueIndex = i + 1;
    } else if (arg.startsWith('--extension=')) {
      value = arg.slice('--extension='.length);
      valueIndex = i;
      tokenPrefix = '--extension=';
    }
    if (value === undefined || value === null || value === '') continue;
    if (path.basename(value) !== T3_EXTENSION_BASENAME) continue;

    let source;
    try {
      source = await fs.promises.readFile(value, 'utf8');
    } catch (err) {
      log(`Cannot read T3 extension ${value}: ${err.message}. Passing it through unadapted.`);
      continue;
    }

    const occurrences = source.split(GET_COMMANDS_MARKER).length - 1;
    if (occurrences !== 1) {
      log(
        `T3 extension ${value} no longer matches the known source (getCommands marker found ${occurrences} times). ` +
        'Passing it through unadapted; $name skill inlining will fail until omp-t3 is updated.'
      );
      continue;
    }

    const adapted = source.replace(GET_COMMANDS_MARKER, GET_COMMANDS_REPLACEMENT);
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      // Content-addressed rewrite: only touch the file when the output
      // differs, so repeated launches don't churn the cache.
      let existing = null;
      try {
        existing = fs.readFileSync(cachePath, 'utf8');
      } catch {
        // First run or cache cleared.
      }
      if (existing !== adapted) fs.writeFileSync(cachePath, adapted);
    } catch (err) {
      log(`Cannot write adapted T3 extension copy ${cachePath}: ${err.message}. Passing the original through unadapted.`);
      continue;
    }

    args[valueIndex] = tokenPrefix + cachePath;
    extensionPath = cachePath;
  }
  return { args, extensionPath };
}

module.exports = {
  adaptT3ExtensionArgs,
  T3_EXTENSION_BASENAME,
  GET_COMMANDS_MARKER,
  GET_COMMANDS_REPLACEMENT
};
