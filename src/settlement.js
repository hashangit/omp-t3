'use strict';

/**
 * Tracks turn lifecycle state and harmonizes settlement between OMP and T3 Code.
 */
class SettlementTracker {
  constructor() {
    this.lastPromptStatus = null;
    // Manual compact in flight: T3 sent {"type":"compact"} and omp's RPC
    // handler awaits the whole compaction and answers with a single response
    // record - it never emits auto_compaction_start/end for manual compaction.
    this.pendingManualCompact = false;
    // Held auto_compaction_start line awaiting its end frame (skipped-pair
    // suppression - see handleDownstreamFrame).
    this.bufferedCompactionStart = null;
  }

  /**
   * Inspects upstream frames (T3 Code -> OMP) to anticipate aborts or new prompts.
   * @param {string} line Raw incoming line
   * @returns {{ emit?: string } | null} emit: synthesized downstream line(s)
   *   the proxy must write to T3 Code (compaction_start for manual compacts).
   */
  handleUpstreamFrame(line) {
    if (
      line.includes('"type":"compact"') ||
      line.includes('"type": "compact"')
    ) {
      // T3 renders compaction UI solely from compaction_start/compaction_end
      // events and ignores a success:true compact response, so synthesize the
      // start card now; handleDownstreamFrame synthesizes the end card when
      // omp answers.
      this.pendingManualCompact = true;
      return {
        emit: JSON.stringify({
          type: 'compaction_start',
          reason: 'user_requested',
          action: 'manual'
        }) + '\n'
      };
    }
    if (line.includes('"type":"prompt"') || line.includes('"type": "prompt"')) {
      this.lastPromptStatus = null;
    } else if (
      line.includes('"type":"abort"') ||
      line.includes('"type": "abort"') ||
      line.includes('"type":"abort_and_prompt"') ||
      line.includes('"type": "abort_and_prompt"')
    ) {
      this.lastPromptStatus = 'aborted';
    }
    return null;
  }

  /**
   * Completes the synthesized manual-compaction event pair: when omp's
   * `command:"compact"` response crosses downstream, emit a Pi-contract
   * `compaction_end` before it. The response itself is still forwarded
   * (T3 matches it to clear its in-flight flag and schedule its settle probe).
   * @param {string} line Raw line emitted by OMP
   * @returns {{ handled: boolean, suppress?: boolean, emit?: string }}
   */
  handleManualCompactResponse(line) {
    if (!this.pendingManualCompact) return { handled: false };
    if (
      !line.includes('"type":"response"') &&
      !line.includes('"type": "response"')
    ) return { handled: false };
    if (
      !line.includes('"command":"compact"') &&
      !line.includes('"command": "compact"')
    ) return { handled: false };

    this.pendingManualCompact = false;
    let end;
    try {
      const parsed = JSON.parse(line);
      if (parsed.success === false) {
        end = {
          type: 'compaction_end',
          aborted: false,
          willRetry: false,
          errorMessage:
            (parsed.error && typeof parsed.error === 'string' && parsed.error) ||
            'omp context compaction failed.'
        };
      } else {
        const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
        const result = {
          summary:
            (typeof data.summary === 'string' && data.summary) ||
            'Context compacted.'
        };
        if (typeof data.tokensBefore === 'number' && data.tokensBefore >= 0) {
          result.tokensBefore = Math.floor(data.tokensBefore);
        }
        end = { type: 'compaction_end', aborted: false, willRetry: false, result };
      }
    } catch {
      // Non-JSON response shape: still close the card so the T3 turn can settle
      end = {
        type: 'compaction_end',
        aborted: false,
        willRetry: false,
        errorMessage: 'omp context compaction ended unexpectedly.'
      };
    }
    return { handled: true, emit: JSON.stringify(end) + '\n' + line + '\n' };
  }

  /**
   * Inspects downstream frames (OMP -> T3 Code) for settlement events.
   * @param {string} line Raw line emitted by OMP
   * @returns {{ handled: boolean, suppress?: boolean, emit?: string }}
   */
  handleDownstreamFrame(line) {
    // Complete a synthesized manual-compaction pair when omp answers compact
    if (this.pendingManualCompact) {
      const compactResult = this.handleManualCompactResponse(line);
      if (compactResult.handled) {
        return compactResult;
      }
    }

    // Local-only slash commands (e.g. /context, /stats) complete with the
    // response itself carrying data.agentInvoked:false; no prompt_result and
    // no session_settled ever follow, and T3's own command-only settle probe
    // is suppressed once the turn has rendered output. Synthesize the
    // terminal agent_settled here; forward the original response untouched.
    if (line.includes('"agentInvoked":false')) {
      try {
        const parsed = JSON.parse(line);
        if (
          parsed.type === 'response' &&
          parsed.command === 'prompt' &&
          parsed.success === true &&
          parsed.data &&
          parsed.data.agentInvoked === false
        ) {
          return {
            handled: true,
            suppress: false,
            emit:
              line + '\n' +
              JSON.stringify({ type: 'agent_settled', aborted: this.lastPromptStatus === 'aborted' }) + '\n'
          };
        }
      } catch {
        // Fall through to the other handlers.
      }
    }

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
    // Check for get_state responses: T3's settle probe finalizes a turn only
    // when data.pendingMessageCount === 0. omp exposes the same signal as
    // queuedMessageCount, so inject the alias T3 reads.
    if (line.includes('"command":"get_state"') || line.includes('"command": "get_state"')) {
      try {
        const parsed = JSON.parse(line);
        if (
          parsed.type === 'response' &&
          parsed.success === true &&
          parsed.data &&
          typeof parsed.data === 'object' &&
          typeof parsed.data.queuedMessageCount === 'number' &&
          parsed.data.pendingMessageCount === undefined
        ) {
          parsed.data.pendingMessageCount = parsed.data.queuedMessageCount;
          return { handled: true, emit: JSON.stringify(parsed) + '\n' };
        }
      } catch {
        // Fall through to passthrough
      }
    }

    // omp renames pi's compaction events with an auto_ prefix. Auto-compaction
    // is a method cascade: omp frequently emits attempts with
    // `{"skipped":true}` and no result ("handoff"/"shake"/"context-full" -
    // this method didn't apply, trying the next). T3 renders ANY
    // compaction_end without `result` as "Context compaction failed", so
    // skipped pairs MUST never surface. Buffer each start and drop the pair
    // when the end reports skipped:true; forward real pairs together.
    if (line.includes('"type":"auto_compaction_start"') || line.includes('"type": "auto_compaction_start"')) {
      this.bufferedCompactionStart = line;
      return { handled: true, suppress: true };
    }
    if (line.includes('"type":"auto_compaction_end"') || line.includes('"type": "auto_compaction_end"')) {
      const startLine = this.bufferedCompactionStart;
      this.bufferedCompactionStart = null;
      if (this.isSkippedCompaction(line)) {
        return { handled: true, suppress: true };
      }
      const endLine = this.renameType(line, 'compaction_end');
      if (!startLine) {
        return { handled: true, emit: endLine };
      }
      return { handled: true, emit: this.renameType(startLine, 'compaction_start') + endLine };
    }

    // Suppress OMP-specific internal advisor_cost_changed
    if (line.includes('"type":"advisor_cost_changed"') || line.includes('"type": "advisor_cost_changed"')) {
      return { handled: true, suppress: true };
    }

    // Passthrough
    return { handled: false };
  }

  /**
   * Checks whether an auto_compaction_end reports a skipped (not applied)
   * attempt. omp's cascade emits these constantly; they are progress noise,
   * not failures.
   * @param {string} line Raw auto_compaction_end line
   * @returns {boolean}
   */
  isSkippedCompaction(line) {
    if (line.includes('"skipped":true') || line.includes('"skipped": true')) {
      return true;
    }
    try {
      return JSON.parse(line).skipped === true;
    } catch {
      return false;
    }
  }

  /**
   * Renames the type field of a JSON line, preserving all other fields.
   * @param {string} line Raw JSON line
   * @param {string} type New type value
   * @returns {string}
   */
  renameType(line, type) {
    try {
      const parsed = JSON.parse(line);
      parsed.type = type;
      return JSON.stringify(parsed) + '\n';
    } catch {
      return line.replace(/"type":\s*"auto_compaction_(start|end)"/, `"type":"${type}"`) + '\n';
    }
  }
}

module.exports = {
  SettlementTracker
};
