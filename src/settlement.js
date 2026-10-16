'use strict';

/**
 * Tracks turn lifecycle state and harmonizes settlement between OMP and T3 Code.
 */
class SettlementTracker {
  constructor() {
    this.lastPromptStatus = null;
  }

  /**
   * Inspects upstream frames (T3 Code -> OMP) to anticipate aborts or new prompts.
   * @param {string} line Raw incoming line
   */
  handleUpstreamFrame(line) {
    if (line.includes('"type":"prompt"') || line.includes('"type": "prompt"')) {
      this.lastPromptStatus = null;
    } else if (line.includes('"type":"abort"') || line.includes('"type": "abort"')) {
      this.lastPromptStatus = 'aborted';
    }
  }

  /**
   * Inspects downstream frames (OMP -> T3 Code) for settlement events.
   * @param {string} line Raw line emitted by OMP
   * @returns {{ handled: boolean, suppress?: boolean, emit?: string }}
   */
  handleDownstreamFrame(line) {
    // Check for prompt_result
    if (line.includes('"type":"prompt_result"') || line.includes('"type": "prompt_result"')) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.status) {
          this.lastPromptStatus = parsed.status;
        }
      } catch {
        // Fallback simple regex if malformed
        if (line.includes('"aborted"')) {
          this.lastPromptStatus = 'aborted';
        } else if (line.includes('"completed"')) {
          this.lastPromptStatus = 'completed';
        }
      }
      // Suppress prompt_result because T3 PiAdapter does not recognize it
      return { handled: true, suppress: true };
    }

    // Check for session_settled -> translate to agent_settled
    if (line.includes('"type":"session_settled"') || line.includes('"type": "session_settled"')) {
      const isAborted = this.lastPromptStatus === 'aborted';
      const synthesized = JSON.stringify({
        type: 'agent_settled',
        aborted: isAborted
      }) + '\n';

      return {
        handled: true,
        suppress: false,
        emit: synthesized
      };
    }

    // Suppress OMP-specific internal advisor_cost_changed
    if (line.includes('"type":"advisor_cost_changed"') || line.includes('"type": "advisor_cost_changed"')) {
      return { handled: true, suppress: true };
    }

    // Passthrough
    return { handled: false };
  }
}

module.exports = {
  SettlementTracker
};
