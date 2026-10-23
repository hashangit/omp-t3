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
    // Agent activity cycle tracking. omp emits agent_start/agent_end around
    // every model cycle (prompt turn, steered reply, background-wake reply),
    // but only follows agent_end with session_settled when NOTHING can wake
    // the session again (prompt_result.sessionSettled === true). While
    // background jobs or detached subagents are pending, omp withholds
    // session_settled until that work drains - which can be minutes or
    // never (long-lived dev servers). The T3 run must MIRROR the omp
    // session: it stays open across the pause, the wake cycle streams into
    // it, and the translated session_settled finalizes it. agent_end is
    // therefore never a settle point on its own - only an abort is (T3
    // finalizes interrupted turns on agent_settled, and no session_settled
    // follows an abort while work stays pending).
    this.cycleActive = false;
    // True once an agent_start was observed for the current upstream turn.
    // Gates the prompt_result fallback settle so turns that ran real cycles
    // settle exactly once, from session_settled.
    this.sawCycleThisTurn = false;
    this.settledThisCycle = false;
    // True between an upstream abort command and the settle synthesized for
    // it, so the synthesized settle reports aborted:true.
    this.sawAbort = false;
    // Hold-open observers (feature 002 FR4). Invoked whenever a frame proves
    // settlement is withheld because async work is pending. The proxy wires
    // these to the notice channel; both are optional so standalone tracker
    // use (tests) stays silent.
    this.onHoldOpen = null;
    this.pendingSubagents = null;
  }

  /**
   * Build hold-open info for the notice channel. The subagent count is
   * supplied by the proxy (SubagentBridge.pendingCount) and is authoritative
   * only when at least one live unfinished subagent is tracked — omp exposes
   * background jobs as a boolean, never counts.
   * @returns {{ pendingSubagents: number, countAuthoritative: boolean }}
   */
  holdInfo() {
    const count = typeof this.pendingSubagents === 'function' ? this.pendingSubagents() : 0;
    return { pendingSubagents: count, countAuthoritative: count > 0 };
  }

  /** Fires the hold-open observer when one is wired. */
  tickHoldOpen() {
    if (typeof this.onHoldOpen === 'function') this.onHoldOpen(this.holdInfo());
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
      this.sawCycleThisTurn = false;
    } else if (
      line.includes('"type":"abort"') ||
      line.includes('"type": "abort"') ||
      line.includes('"type":"abort_and_prompt"') ||
      line.includes('"type": "abort_and_prompt"')
    ) {
      this.lastPromptStatus = 'aborted';
      this.sawAbort = true;
      // Idle abort: no agent cycle is open (background work pending, session
      // paused), so no agent_end will follow to synthesize the settle from -
      // and omp withholds session_settled while the work stays pending.
      // Emit the terminal now so T3 finalizes the interrupted turn instead
      // of waiting forever. omp keeps the pending work alive for the
      // session; the later wake cycle is adopted as a continuation.
      if (!this.cycleActive) {
        this.settledThisCycle = true;
        return {
          emit: JSON.stringify({ type: 'agent_settled', aborted: true }) + '\n'
        };
      }
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

    // Agent cycle boundaries. Top-level type comparison (never substring):
    // subagent_event payload events embed {"type":"agent_end"} for CHILD
    // sessions, and those frames must still reach the subagent bridge.
    if (line.includes('"agent_start"') || line.includes('"agent_end"')) {
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = null;
      }
      if (parsed && parsed.type === 'agent_start') {
        this.cycleActive = true;
        this.sawCycleThisTurn = true;
        this.settledThisCycle = false;
        this.sawAbort = false;
        return { handled: false };
      }
      if (parsed && parsed.type === 'agent_end' && this.cycleActive) {
        this.cycleActive = false;
        if (this.sawAbort) {
          // The abort finalized this cycle: T3 finalizes interrupted turns
          // on agent_settled, and no session_settled follows while pending
          // work remains, so synthesize the terminal now. Forward agent_end
          // untouched (byte-passthrough invariant), then append it.
          // sawAbort only (never lastPromptStatus): the abort flag is set by
          // this cycle's upstream abort frame and cleared by the next
          // agent_start - lastPromptStatus belongs to the previous turn and
          // must not turn a later wake cycle into a spurious aborted settle.
          this.settledThisCycle = true;
          return {
            handled: true,
            suppress: false,
            emit:
              line + '\n' +
              JSON.stringify({ type: 'agent_settled', aborted: true }) + '\n'
          };
        }
        // Normal cycle end. Do NOT settle here: while background work is
        // pending, omp withholds session_settled and the wake cycle that
        // delivers the results must stream into this still-active T3 run.
        // The session_settled translation below is the single settle point
        // once omp reports the session drained.
        return { handled: false };
      }
      return { handled: false };
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
      let status = null;
      let agentInvoked = false;
      let parsedSessionSettled;
      try {
        const parsed = JSON.parse(line);
        if (parsed.status) {
          this.lastPromptStatus = parsed.status;
          status = parsed.status;
        }
        agentInvoked = parsed.agentInvoked === true;
        parsedSessionSettled = parsed.sessionSettled;
      } catch {
        // Fallback simple regex if malformed
        if (line.includes('"aborted"')) {
          this.lastPromptStatus = status = 'aborted';
        } else if (line.includes('"completed"')) {
          this.lastPromptStatus = status = 'completed';
        }
      }
      // Fallback settle for turns whose agent frames were never observed
      // (e.g. the shim attached mid-turn): without it the turn would hang
      // until session_settled. Two gates keep it from settling a healthy
      // run: (1) an agent cycle WAS observed (sawCycleThisTurn) - then
      // session_settled owns the settle; (2) omp reports pending background
      // work (sessionSettled:false) - then the run must stay active until
      // the work drains and the wake cycle reports.
      if (agentInvoked && !this.settledThisCycle && !this.sawCycleThisTurn && parsedSessionSettled !== false) {
        this.settledThisCycle = true;
        this.cycleActive = false;
        return {
          handled: true,
          suppress: false,
          emit: JSON.stringify({ type: 'agent_settled', aborted: status === 'aborted' }) + '\n'
        };
      }
      // sessionSettled:false proves settlement is withheld for pending work
      // (feature 002 FR4): the run stays open by design, so say so in-thread.
      if (agentInvoked && parsedSessionSettled === false) {
        this.tickHoldOpen();
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
    // when data.pendingMessageCount === 0 (and isStreaming/isCompacting are
    // false). omp reports queued user messages as queuedMessageCount and
    // background jobs / detached subagents as hasPendingAsyncWork - the two
    // together are the truth about whether the session can still produce
    // output, so the alias must carry both: while work is pending the probe
    // keeps the T3 run open, and the drain -> wake -> session_settled
    // sequence finalizes it with the results inside the same run.
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
          parsed.data.pendingMessageCount =
            parsed.data.queuedMessageCount + (parsed.data.hasPendingAsyncWork === true ? 1 : 0);
          // T3's settle probe is the recurring proof that async work is still
          // pending mid-run; refresh the hold-open signature from it too (the
          // subagent count may have become known since prompt_result).
          if (parsed.data.hasPendingAsyncWork === true) {
            this.tickHoldOpen();
          }
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
