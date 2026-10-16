'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * Ensures ~/.pi/agent/sessions is linked to ~/.omp/agent/sessions
 * so T3 Code's background usage scraper can discover OMP historical sessions.
 * @param {boolean} silent If true, suppresses console output
 * @returns {{ success: boolean, message: string }}
 */
function setupSessionSymlink(silent = false) {
  const homeDir = os.homedir();
  const ompSessionsDir = path.join(homeDir, '.omp', 'agent', 'sessions');
  const piAgentDir = path.join(homeDir, '.pi', 'agent');
  const piSessionsLink = path.join(piAgentDir, 'sessions');

  try {
    // Ensure ~/.omp/agent/sessions exists
    if (!fs.existsSync(ompSessionsDir)) {
      fs.mkdirSync(ompSessionsDir, { recursive: true });
    }

    // Ensure ~/.pi/agent directory exists
    if (!fs.existsSync(piAgentDir)) {
      fs.mkdirSync(piAgentDir, { recursive: true });
    }

    // Check existing target at ~/.pi/agent/sessions
    if (fs.existsSync(piSessionsLink)) {
      const stat = fs.lstatSync(piSessionsLink);
      if (stat.isSymbolicLink()) {
        const currentTarget = fs.readlinkSync(piSessionsLink);
        if (currentTarget === ompSessionsDir || path.resolve(piAgentDir, currentTarget) === ompSessionsDir) {
          const msg = `Symlink already active: ${piSessionsLink} -> ${ompSessionsDir}`;
          if (!silent) console.log(msg);
          return { success: true, message: msg };
        }
      }
      // If it exists as a real directory or pointing elsewhere, don't destroy without warning
      const msg = `Existing path at ${piSessionsLink} is not pointing to ${ompSessionsDir}. Skipping overwrite.`;
      if (!silent) console.warn(msg);
      return { success: false, message: msg };
    }

    // Create the symbolic link
    fs.symlinkSync(ompSessionsDir, piSessionsLink, 'junction');
    const msg = `Successfully created symlink: ${piSessionsLink} -> ${ompSessionsDir}`;
    if (!silent) console.log(msg);
    return { success: true, message: msg };
  } catch (err) {
    const msg = `Failed to create session symlink: ${err.message}`;
    if (!silent) console.error(msg);
    return { success: false, message: msg };
  }
}

module.exports = {
  setupSessionSymlink
};
