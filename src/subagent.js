'use strict';

/**
 * Normalizes OMP subagent events and tool names into T3 Code Pi subagent conventions.
 */
class SubagentBridge {
  /**
   * Handles downstream frame from OMP.
   * @param {string} line 
   * @returns {{ handled: boolean, line?: string }}
   */
  handleDownstreamFrame(line) {
    let modified = false;

    // Check for task:subagent:event
    if (line.includes('"task:subagent:event"')) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'task:subagent:event') {
          parsed.type = 'subagent_event';
          return { handled: true, line: JSON.stringify(parsed) + '\n' };
        }
      } catch {
        // Fallback simple string replace
        return {
          handled: true,
          line: line.replace('"task:subagent:event"', '"subagent_event"') + '\n'
        };
      }
    }

    // Check for tool execution involving "task" tool
    if (
      line.includes('"tool":"task"') ||
      line.includes('"tool": "task"') ||
      line.includes('"name":"task"') ||
      line.includes('"name": "task"')
    ) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.tool === 'task') {
          parsed.tool = 'subagent';
          modified = true;
        }
        if (parsed.name === 'task') {
          parsed.name = 'subagent';
          modified = true;
        }
        if (modified) {
          return { handled: true, line: JSON.stringify(parsed) + '\n' };
        }
      } catch {
        // Fallback string replacement
        const replaced = line
          .replace('"tool":"task"', '"tool":"subagent"')
          .replace('"tool": "task"', '"tool": "subagent"')
          .replace('"name":"task"', '"name":"subagent"')
          .replace('"name": "task"', '"name": "subagent"');
        return { handled: true, line: replaced + '\n' };
      }
    }

    return { handled: false };
  }
}

module.exports = {
  SubagentBridge
};
