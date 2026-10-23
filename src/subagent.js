'use strict';

/**
 * Normalizes OMP subagent frames into T3 Code Pi subagent conventions.
 *
 * T3's Pi provider derives the entire subagent UI from tool_execution frames
 * whose top-level `toolName` is "subagent" (see provider-pi server adapter:
 * emitToolItem / emitSubagentTasks). Per subagent it requires
 * `result.details.results[]` entries with string fields `agent` and `task`,
 * plus optional `step`, `finished`, `stopReason`, `exitCode`, `model`.
 *
 * OMP instead names the tool "task" and reports live children in
 * `result.details.progress[]` ({ index, id, agent, status, task, ... }),
 * while `results[]` stays empty at spawn time. This bridge renames the tool
 * and merges `progress[]` into `results[]` so T3 renders subagent cards.
 *
 * OMP's separate subagent_lifecycle/progress/event frames (gated by
 * `set_subagent_subscription {level:"events"}`) are consumed here: they carry
 * per-child `parentToolCallId`, `id`, `index`, status, model identity, and
 * assistant text snapshots. The bridge turns them into synthesized
 * `tool_execution_update` frames for the owning `subagent` toolCallId with
 * `partialResult.details.results[]` entries enriched with `messages[]` (the
 * text T3's piSubagentOutput reads for progress/result display) and `model`.
 * The raw subagent_* frames are suppressed: T3's adapter ignores unknown
 * event types, so forwarding them is pure noise.
 *
 * Stop + reconciliation alignment (T3's own adapters stop a subagent's
 * children when the parent run is interrupted; omp exposes the same levers
 * over RPC). T3's Pi adapter finalizes a run on `agent_settled` without
 * sweeping open subagent rows, and drops every later frame — so children
 * still marked running when the run dies stay "running" forever (T3 DB
 * zombies). Two bridge mechanisms close that gap:
 *
 * - `abortSweep()`: called synchronously when T3 interrupts (upstream
 *   `abort`/`abort_and_prompt`), BEFORE any settle synthesis reaches T3.
 *   Terminalizes every tracked unfinished entry (`stopReason:"aborted"` →
 *   T3 status `interrupted`) and returns `cancel_subagent` requests so omp
 *   actually hard-kills detached children instead of running them on
 *   invisibly.
 * - `refreshRequest()`/`mergeSnapshots()`: periodic `get_subagents`
 *   reconciliation (single-flight, rate-limited). omp's snapshot is the
 *   authoritative live child list — it heals missed spawn/lifecycle events,
 *   attributes withheld children, and keeps names, mandates, and narration
 *   current. Snapshots never un-finish an entry: events stay authoritative
 *   for terminal states.
 *
 * Attribution under parallel fan-out (feature 002 US9/FR14): a child frame
 * or snapshot resolves its owning `task` tool call by the contract §5.3
 * ordered rule — explicit known parent, then the child's recorded owner in
 * the live-child registry, then the only task call ever seen, then the
 * explicit parent when no task call was ever seen; otherwise the update is
 * ambiguous and WITHHELD from rendering (no card minted) while the child
 * stays registered (`ownerCallId: null`) for the interrupt sweep to cancel
 * (FR19) and a reconciliation refresh is requested. An open task call alone
 * is never proof of ownership: the last-started-call fallback that minted
 * the incident's phantom cards is gone.
 *
 * Bridge-injected RPC ids live in the `ompt3-sub-` namespace; their
 * responses are consumed here and suppressed (T3's adapter would ignore
 * them, but the wire stays clean).
 */
const SUBAGENT_EVENT_TYPES = new Set(['subagent_lifecycle', 'subagent_progress', 'subagent_event']);

/** piSubagentOutput reads only assistant messages' text content. */
function messagesFromText(text) {
  return text ? [{ role: 'assistant', content: [{ type: 'text', text }] }] : undefined;
}

/** omp SubagentStatus/SubagentLifecycleStatus values that end a child. */
function isTerminalStatus(status) {
  return status === 'completed' || status === 'done' || status === 'success'
    || status === 'aborted' || status === 'failed' || status === 'error';
}

/**
 * Maps a terminal omp status onto the T3 entry fields it implies. Non-terminal
 * statuses map to { finished: false }.
 */
function terminalOutcome(status) {
  if (status === 'completed' || status === 'done' || status === 'success') {
    return { finished: true };
  }
  if (status === 'aborted') return { finished: true, stopReason: 'aborted' };
  if (status === 'failed' || status === 'error') {
    return { finished: true, stopReason: 'error', exitCode: 1 };
  }
  return { finished: false };
}
class SubagentBridge {
  constructor() {
    // parentToolCallId -> Map(id -> T3 results entry)
    this.subagentsByCall = new Map();
    // Tool call ids that ever invoked the `task` tool (never pruned), and
    // the OPEN subset (task tool_execution_start adds, end removes).
    // Subagent frames are re-parented here: omp attributes late events
    // (completion during a later `wait`/bash call) to whichever tool is
    // active at that moment, which would split one child into several T3
    // nodes keyed `${parentToolCallId}:subagent:${step}` - one of them then
    // never terminates and T3's tree shows "Waiting on background task
    // subagent" forever.
    this.taskCalls = new Set();
    this.openCalls = new Set();
    // Live-child registry (feature 002 FR19): EVERY observed child id,
    // attributed or not. childId -> { ownerCallId, step, live, status }.
    // Withheld (unattributable) children stay registered with
    // ownerCallId:null so the interrupt sweep still cancels them by id;
    // `step` freezes at first attributed attach (FR15); `live` flips false
    // on terminal status and when the sweep cancels the entry.
    this.childRegistry = new Map();
    // Bridge-injected RPC state (ompt3-sub- id namespace): sequence counter
    // plus single-flight/rate-limit state for get_subagents reconciliation.
    this.seq = 0;
    this.refreshPending = false;
    this.lastRefreshAt = 0;
    this.refreshMinIntervalMs = 1000;
    // Transient flag: handleDownstreamFrame sets it when a NEW task tool
    // call starts; the proxy reads it to trigger get_subagents refresh.
    this.newTaskCallStarted = false;
    // Transient flag: set when an observation conflicts with established
    // ownership (a known parent contradicting the recorded owner); the
    // proxy reads it to trigger get_subagents refresh, same channel as
    // newTaskCallStarted.
    this.reconciliationNeeded = false;
    // Synthesized owner-card updates produced while handling a frame whose
    // own rendering was withheld (conflicting parent, tool-channel
    // conflicts). handleDownstreamFrame appends them to the outgoing line.
    this.pendingOwnerLines = [];
  }

  /**
   * Returns and clears owner-card update lines accumulated while handling
   * the current frame.
   * @returns {string}
   */
  takePendingOwnerLines() {
    if (this.pendingOwnerLines.length === 0) return '';
    const out = this.pendingOwnerLines.join('');
    this.pendingOwnerLines.length = 0;
    return out;
  }

  /**
   * Projects a terminal observation onto the recorded owner's rendered
   * card. Conflict and withhold paths update the registry for a child
   * whose card lives under another call — without this projection the
   * owner's entry stays `finished:false` into the settle (the original
   * zombie mechanism under a new input sequence). Terminal-sticky: an
   * already terminal entry keeps its own outcome (first terminal wins).
   * @param {{ ownerCallId?: string|null }} rec registry record
   * @param {string} childId
   * @param {{ finished?: boolean, stopReason?: string, exitCode?: number }} observation
   * @returns {string|undefined} synthesized owner update line, or undefined
   */
  projectTerminalToOwner(rec, childId, observation) {
    if (!rec || !rec.ownerCallId || observation.finished !== true) return undefined;
    const calls = this.subagentsByCall.get(rec.ownerCallId);
    const entry = calls && calls.get(childId);
    if (!entry || entry.finished === true) return undefined;
    entry.finished = true;
    if (observation.stopReason !== undefined) entry.stopReason = observation.stopReason;
    if (observation.exitCode !== undefined && entry.exitCode === undefined) {
      entry.exitCode = observation.exitCode;
    }
    return this.synthesizeUpdate(rec.ownerCallId, calls);
  }

  /**
   * Handles downstream frame from OMP.
   * @param {string} line
   * @returns {{ handled: boolean, line?: string }}
   */
  handleDownstreamFrame(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Non-JSON lines pass through untouched; blind string replacement risks
      // corrupting payloads that merely mention these literals inside strings.
      return { handled: false };
    }

    if (SUBAGENT_EVENT_TYPES.has(parsed.type)) {
      return this.handleSubagentFrame(parsed);
    }

    const isToolExecution =
      parsed.type === 'tool_execution_start' ||
      parsed.type === 'tool_execution_update' ||
      parsed.type === 'tool_execution_end';
    if (!isToolExecution) return { handled: false };

    const invoked = parsed.toolName === 'task' || parsed.tool === 'task' || parsed.name === 'task';

    if (parsed.type === 'tool_execution_start' && invoked && parsed.toolCallId) {
      const isNew = !this.taskCalls.has(parsed.toolCallId);
      this.taskCalls.add(parsed.toolCallId);
      this.openCalls.add(parsed.toolCallId);
      if (isNew) this.newTaskCallStarted = true;
    }

    if (!invoked) return { handled: false };

    if (parsed.type === 'tool_execution_end' && parsed.toolCallId) {
      // The parent tool call finished: T3 forces its entries finished, so the
      // per-call child map is dead weight from here on.
      this.subagentsByCall.delete(parsed.toolCallId);
      this.openCalls.delete(parsed.toolCallId);
    }

    let modified = false;
    if (parsed.toolName === 'task') {
      parsed.toolName = 'subagent';
      modified = true;
    }
    if (parsed.tool === 'task') {
      parsed.tool = 'subagent';
      modified = true;
    }
    if (parsed.name === 'task') {
      parsed.name = 'subagent';
      modified = true;
    }

    if (this.normalizeTaskRecords(parsed.result, parsed.toolCallId)) modified = true;
    if (this.normalizeTaskRecords(parsed.partialResult, parsed.toolCallId)) modified = true;
    const taskStarted = this.newTaskCallStarted;
    this.newTaskCallStarted = false;
    const conflict = this.reconciliationNeeded;
    this.reconciliationNeeded = false;
    const ownerLines = this.takePendingOwnerLines();
    return {
      handled: true,
      line: (modified ? JSON.stringify(parsed) + '\n' : line + '\n') + ownerLines,
      ...(taskStarted ? { taskStarted: true } : {}),
      ...(conflict ? { refreshRequested: true } : {})
    };
  }

  /**
   * Consumes an OMP subagent_lifecycle/progress/event frame and emits a
   * synthesized tool_execution_update so T3 refreshes the subagent cards.
   * @param {{ type: string, payload?: unknown }} parsed
   * @returns {{ handled: boolean, line?: string }}
   */
  handleSubagentFrame(parsed) {
    const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
    const nested = payload.progress && typeof payload.progress === 'object' ? payload.progress : {};
    // Identify the child: lifecycle/event use payload.id; progress nests it
    // in payload.progress.id. Index and text live at different depths too.
    const id = typeof payload.id === 'string' && payload.id
      ? payload.id
      : (typeof nested.id === 'string' && nested.id ? nested.id : null);
    if (!id) return { handled: true };

    const ownIndex = typeof payload.index === 'number' ? payload.index
      : typeof nested.index === 'number' ? nested.index : undefined;
    const observedStatus = typeof payload.status === 'string' ? payload.status
      : typeof nested.status === 'string' ? nested.status : undefined;
    const event = parsed.type === 'subagent_event' && payload.event && typeof payload.event === 'object'
      ? payload.event
      : {};

    // Trust omp's explicit parent only when it is actually a `task` tool
    // call; late events fired during a later tool (wait, bash) would
    // otherwise spawn a second, never-terminating T3 node under that tool.
    const callId = this.resolveCallId(
      typeof payload.parentToolCallId === 'string' ? payload.parentToolCallId : null,
      id
    );
    if (!callId) {
      // FR14/FR19: ambiguous or unattachable update — withheld from
      // rendering (no card is minted), but the child is real and registered
      // live so the interrupt sweep still cancels it by id. Reconciliation
      // is requested: the authoritative snapshot may attribute it.
      let observation;
      if (parsed.type === 'subagent_event') {
        const done = event.type === 'agent_end';
        observation = { live: !done, finished: done };
      } else {
        const t = terminalOutcome(observedStatus);
        observation = {
          status: observedStatus,
          live: !t.finished,
          finished: t.finished,
          stopReason: t.stopReason,
          exitCode: t.exitCode
        };
      }
      this.registerObserved(id, null, undefined, observation);
      // The registry carries the outcome; the recorded owner's card must
      // carry it too, or the card stays running into the settle (zombie).
      const ownerLine = this.projectTerminalToOwner(this.childRegistry.get(id), id, observation);
      return {
        handled: true,
        ...(ownerLine ? { line: ownerLine } : {}),
        refreshRequested: true
      };
    }

    let calls = this.subagentsByCall.get(callId);
    if (!calls) {
      calls = new Map();
      this.subagentsByCall.set(callId, calls);
    }

    // FR15: the projected step is part of T3's node identity, so it is
    // assigned exactly once at first attributed attach and frozen for the
    // child's lifetime (duplicate/missing indices and event/snapshot
    // disagreement must never mint a second node for one child). FR17: a
    // child whose map was pruned re-attaches with its terminal state.
    const entry = calls.get(id) ?? this.attachChild(calls, callId, id, ownIndex);

    if (parsed.type === 'subagent_lifecycle') {
      const name = typeof nested.agent === 'string' && nested.agent ? nested.agent : payload.agent;
      if (typeof name === 'string' && name) entry.agent = name !== 'task' ? name : id;
      // SubagentLifecyclePayload carries the mandate as `description`
      // (no `task` field); progress frames carry it as `task`.
      const desc = typeof nested.task === 'string' && nested.task ? nested.task
        : typeof payload.task === 'string' && payload.task ? payload.task
          : typeof payload.description === 'string' && payload.description ? payload.description : null;
      if (desc) entry.task = desc;
      this.applyStatus(entry, payload.status);
    } else if (parsed.type === 'subagent_progress') {
      const name = typeof nested.agent === 'string' && nested.agent ? nested.agent : payload.agent;
      if (typeof name === 'string' && name) entry.agent = name !== 'task' ? name : id;
      const desc = typeof nested.task === 'string' && nested.task ? nested.task : payload.task;
      if (typeof desc === 'string' && desc) entry.task = desc;
      if (typeof nested.resolvedModelIdentity === 'string' && nested.resolvedModelIdentity) {
        entry.model = nested.resolvedModelIdentity;
      } else if (typeof nested.resolvedModel === 'string' && nested.resolvedModel) {
        entry.model = nested.resolvedModel;
      }
      this.applyStatus(entry, nested.status);
      // Feature 002 FR6: omp's first-person step narration (18.12.3+).
      if (typeof nested.lastIntent === 'string' && nested.lastIntent) {
        entry._intent = nested.lastIntent;
      }
      if (typeof nested.recentOutput === 'string' && nested.recentOutput) {
        entry._text = nested.recentOutput;
      }
    } else if (parsed.type === 'subagent_event') {
      const message = event.message && typeof event.message === 'object' ? event.message : null;
      if (message && message.role === 'assistant' && Array.isArray(message.content)) {
        const text = message.content
          .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('');
        if (text) entry._text = text;
      }
      if (event.type === 'agent_end') entry.finished = true;
    }

    // piSubagentOutput reads messages[] for progress/result text. Narration
    // precedence (feature 002 FR6): while the child runs, its own step
    // narration (`lastIntent`) wins; once finished, the latest assistant text
    // wins; recentOutput is the output-tail fallback for both cases.
    const narration = entry.finished
      ? (entry._text ?? entry._intent)
      : (entry._intent ?? entry._text);
    const messages = messagesFromText(narration);
    if (messages) entry.messages = messages;

    // FR19: every observed child is registered — attributed children with
    // their owner and frozen step, so parentless follow-up frames resolve
    // via the registry (§5.3 rule 2). The terminal outcome is recorded so
    // it survives per-call map pruning (FR15/FR17).
    this.registerObserved(id, callId, entry.step, {
      status: observedStatus,
      live: entry.finished !== true,
      finished: entry.finished === true,
      stopReason: entry.stopReason,
      exitCode: entry.exitCode
    });

    return { handled: true, line: this.synthesizeUpdate(callId, calls) };
  }

  /**
   * Resolves which `task` tool call owns a child frame/snapshot — the
   * feature 002 FR14 / contract §5.3 ordered rule, identical for event
   * frames and snapshots:
   *   1. explicit parent that is a KNOWN task call (open or ended — a late
   *      completion arriving during a later `wait`/`bash` lands on its true
   *      parent; wait/bash are not task calls, so they never match) — UNLESS
   *      it conflicts with the recorded owner (see rule 2);
   *   2. a child the bridge has already attributed -> its recorded owner
   *      (registry-first: later parentless frames follow the child, not the
   *      call timeline; a known explicit parent that CONTRADICTS the owner
   *      resolves to null so the caller withholds and reconciles — one
   *      child keeps one parent for life);
   *   3. the ONLY task call ever seen in the session (single-call runs,
   *      open or ended — the pinned parentless-frame behavior);
   *   4. when NO task call was ever seen, the explicit parent (mid-turn
   *      attach).
   *   5. otherwise ambiguous: more than one task call exists in the
   *      session's history and the child is unknown with no usable explicit
   *      parent. AN OPEN TASK CALL ALONE IS NEVER PROOF OF OWNERSHIP — the
   *      last-started-call fallback that minted the incident's phantom
   *      cards is gone; the caller withholds and reconciles instead.
   * @param {string|null} explicit
   * @param {string|null} childId
   * @returns {string|null}
   */
  resolveCallId(explicit, childId) {
    const rec = childId ? this.childRegistry.get(childId) : undefined;
    const owner = rec && rec.ownerCallId;
    if (owner) {
      // FR15: ownership, once established, is not renegotiated. An explicit
      // parent that AGREES with the recorded owner resolves normally (rule
      // 1); a CONFLICTING known parent is withheld for reconciliation —
      // never rendered as a second card under another parent.
      if (explicit && this.taskCalls.has(explicit) && explicit !== owner) return null;
      return owner;
    }
    if (explicit && this.taskCalls.has(explicit)) return explicit;
    if (this.taskCalls.size === 1) {
      for (const only of this.taskCalls) return only;
    }
    if (this.taskCalls.size === 0) return explicit || null;
    return null;
  }

  /**
   * Maps an OMP SubagentStatus/SubagentLifecycleStatus onto a tracked
   * entry. Terminal states stick: an entry is never un-finished, because a
   * terminal lifecycle event is stronger evidence than any later snapshot.
   * @param {{ finished?: boolean }} entry
   * @param {unknown} status
   */
  applyStatus(entry, status) {
    if (typeof status !== 'string' || entry.finished === true) return;
    const t = terminalOutcome(status);
    if (!t.finished) return;
    entry.finished = true;
    if (t.stopReason !== undefined) entry.stopReason = t.stopReason;
    if (t.exitCode !== undefined && entry.exitCode === undefined) entry.exitCode = t.exitCode;
  }

  /**
   * Serializes the tracked children of one task call into the synthesized
   * `tool_execution_update` frame T3's emitSubagentTasks consumes.
   * @param {string} callId
   * @param {Map<string, object>} calls
   * @returns {string}
   */
  synthesizeUpdate(callId, calls) {
    const results = [...calls.entries()]
      .sort((a, b) => (a[1].step ?? 0) - (b[1].step ?? 0))
      .map(([childId, e]) => {
        const out = {};
        out.agent = e.agent ?? childId;
        out.task = e.task ?? '';
        if (e.step !== undefined) out.step = e.step;
        out.finished = e.finished;
        if (e.stopReason !== undefined) out.stopReason = e.stopReason;
        if (e.exitCode !== undefined) out.exitCode = e.exitCode;
        if (e.model !== undefined) out.model = e.model;
        if (e.messages !== undefined) out.messages = e.messages;
        return out;
      });
    return JSON.stringify({
      type: 'tool_execution_update',
      toolCallId: callId,
      toolName: 'subagent',
      partialResult: { content: [], details: { results } }
    }) + '\n';
  }

  /**
   * Terminalizes every tracked unfinished subagent and returns both wire
   * outputs for the interrupt path: synthesized updates for T3 (entries
   * `finished:true, stopReason:"aborted"` -> T3 status `interrupted`, so
   * interrupting a run can never leave subagent rows "running" forever) and
   * one `cancel_subagent` request per live child so omp hard-kills the
   * detached ones instead of running them on invisibly. Mirrors T3's own
   * adapters, which propagate a parent-run interrupt down to the children.
   * Called synchronously on the upstream abort line, BEFORE any settle
   * synthesis is written to T3 (after `agent_settled` the Pi adapter drops
   * every frame - turns are finalized without sweeping open subagent rows).
   * @returns {{ toClient: string[], toOmp: string[] }}
   */
  abortSweep() {
    const toClient = [];
    const toOmp = [];
    const cancelled = new Set();
    const cancelLine = (childId) => JSON.stringify({
      id: `ompt3-sub-${++this.seq}`,
      type: 'cancel_subagent',
      subagentId: childId
    }) + '\n';
    for (const [callId, calls] of this.subagentsByCall) {
      let touched = false;
      for (const [childId, entry] of calls) {
        // Rendered entries: flip registry liveness so the pass below cannot
        // double-cancel, and keep terminal states sticky.
        const rec = this.childRegistry.get(childId);
        if (rec) rec.live = false;
        if (entry.finished === true) continue;
        entry.finished = true;
        if (entry.stopReason === undefined) entry.stopReason = 'aborted';
        touched = true;
        cancelled.add(childId);
        toOmp.push(cancelLine(childId));
        // Record the inflicted outcome so a late snapshot re-attaching this
        // child restores it terminal instead of resurrecting it as running.
        if (rec) {
          rec.finished = true;
          rec.stopReason = entry.stopReason;
          if (entry.exitCode !== undefined) rec.exitCode = entry.exitCode;
        }
      }
      // FR16/FR19: every re-attached child terminalizes in T3 before the
      // settle — including children under a call that already ended (the
      // detached-children shape: late events re-created their entries, so
      // the sweep must close them again; T3's turn is active until the
      // settle, so the update lands).
      if (touched) toClient.push(this.synthesizeUpdate(callId, calls));
    }
    // FR19: withheld (unattributed) children have no owning call, hence no
    // card update — they still contribute a cancellation by id so the
    // interrupt hard-kills every observed live child, rendered or not.
    for (const [childId, rec] of this.childRegistry) {
      if (rec.live !== true) continue;
      rec.live = false;
      if (cancelled.has(childId)) continue;
      rec.finished = true;
      if (rec.stopReason === undefined) rec.stopReason = 'aborted';
      toOmp.push(cancelLine(childId));
    }
    return { toClient, toOmp };
  }

  /**
   * Records an observed child in the live-child registry (FR19). Every
   * observed child id is registered at first sighting, attributed or not;
   * the owner and projected step freeze at first ATTRIBUTED observation
   * (FR15) and are never unset. `live` mirrors the latest observation:
   * true while the child is believed running, false once a terminal status
   * was observed or the sweep cancelled it. The terminal outcome
   * (`finished`/`stopReason`/`exitCode`) is preserved so an entry whose
   * per-call map was pruned can be re-attached in its terminal state
   * instead of resurrecting as running (FR15/FR17: terminal states stick).
   * @param {string} childId
   * @param {string|null} ownerCallId
   * @param {number|undefined} step projected step (only stored with an owner)
   * @param {{ status?: string, live: boolean, finished?: boolean,
   *     stopReason?: string, exitCode?: number }} observation
   * @returns {{ ownerCallId, step, live, status, finished, stopReason, exitCode }}
   */
  registerObserved(childId, ownerCallId, step, observation) {
    let rec = this.childRegistry.get(childId);
    if (!rec) {
      rec = {
        ownerCallId: null,
        step: undefined,
        live: true,
        status: undefined,
        finished: false,
        stopReason: undefined,
        exitCode: undefined
      };
      this.childRegistry.set(childId, rec);
    }
    if (ownerCallId && !rec.ownerCallId) {
      rec.ownerCallId = ownerCallId;
      rec.step = step;
    }
    if (observation.status !== undefined) rec.status = observation.status;
    if (observation.finished === true) {
      rec.finished = true;
      if (observation.stopReason !== undefined) rec.stopReason = observation.stopReason;
      if (observation.exitCode !== undefined) rec.exitCode = observation.exitCode;
    }
    // Terminal stickiness regardless of attribution: once a child is
    // finished, no later observation — stale running progress, tool update,
    // snapshot — may resurrect it as live. Attributed observations carry
    // their entry's sticky state; withheld ones (ownerCallId null) rely on
    // this rule alone.
    rec.live = rec.finished === true ? false : observation.live;
    return rec;
  }

  /**
   * First-attributed-attach entry factory shared by the event, snapshot,
   * and tool-result paths (FR15/FR17): the step is the child's frozen
   * registry step when one exists, else assigned once; a registry-recorded
   * terminal outcome is restored so a re-attached child never resurrects
   * as running.
   * @param {Map<string, object>} calls parent's current rendered children
   * @param {string} callId
   * @param {string} childId
   * @param {number|undefined} ownIndex the child's own fleet index
   * @returns {object} the (newly created) entry
   */
  attachChild(calls, callId, childId, ownIndex) {
    const rec = this.childRegistry.get(childId);
    const frozenStep = rec && rec.ownerCallId === callId && typeof rec.step === 'number'
      ? rec.step
      : undefined;
    const entry = {
      agent: undefined,
      task: '',
      step: frozenStep !== undefined ? frozenStep : this.assignStep(calls, callId, ownIndex),
      finished: false
    };
    if (rec && rec.finished === true) {
      entry.finished = true;
      if (rec.stopReason !== undefined) entry.stopReason = rec.stopReason;
      if (rec.exitCode !== undefined) entry.exitCode = rec.exitCode;
    }
    calls.set(childId, entry);
    return entry;
  }

  /**
   * Assigns the projected step for a child's FIRST attributed attach
   * (FR15 / contract §5.4): the child's own fleet index when present and
   * not already used by a sibling under the same parent, otherwise the next
   * free integer above the parent's current maximum. Sibling steps include
   * registry-recorded steps of children owned by this call, so re-attaches
   * after the parent's per-call map was pruned cannot collide either. The
   * result is frozen by the caller for the child's lifetime.
   * @param {Map<string, object>} calls parent's current rendered children
   * @param {string} callId
   * @param {number|undefined} ownIndex the child's own fleet index
   * @returns {number}
   */
  assignStep(calls, callId, ownIndex) {
    const used = new Set();
    let max = -1;
    const consider = (s) => {
      if (typeof s !== 'number') return;
      used.add(s);
      if (s > max) max = s;
    };
    for (const e of calls.values()) consider(e.step);
    for (const rec of this.childRegistry.values()) {
      if (rec.ownerCallId === callId) consider(rec.step);
    }
    if (typeof ownIndex === 'number' && !used.has(ownIndex)) return ownIndex;
    let next = max + 1;
    while (used.has(next)) next += 1;
    return next;
  }


  /**
   * Single-flight, rate-limited `get_subagents` request line. omp's
   * snapshot is the authoritative live child list; reconciling against it
   * heals missed spawn/lifecycle events and keeps card details current.
   * @returns {string|null} JSONL line to write to omp, or null
   */
  refreshRequest() {
    const now = Date.now();
    if (this.refreshPending) return null;
    if (now - this.lastRefreshAt < this.refreshMinIntervalMs) return null;
    this.refreshPending = true;
    this.lastRefreshAt = now;
    return JSON.stringify({ id: `ompt3-sub-${++this.seq}`, type: 'get_subagents' }) + '\n';
  }

  /**
   * Handles responses to bridge-injected subagent RPC (`ompt3-sub-*`).
   * All are suppressed from T3; `get_subagents` responses additionally
   * reconcile the tracked entries from omp's authoritative snapshot.
   * @param {unknown} parsed
   * @returns {{ handled: boolean, emit?: string }}
   */
  handleBridgeResponse(parsed) {
    if (!parsed || typeof parsed !== 'object') return { handled: false };
    if (parsed.type !== 'response') return { handled: false };
    if (typeof parsed.id !== 'string' || !parsed.id.startsWith('ompt3-sub-')) return { handled: false };
    if (parsed.command === 'get_subagents') {
      this.refreshPending = false;
      if (parsed.success === true && parsed.data && Array.isArray(parsed.data.subagents)) {
        return { handled: true, emit: this.mergeSnapshots(parsed.data.subagents) };
      }
      return { handled: true };
    }
    // cancel_subagent (and any future bridge-only command): suppress.
    return { handled: true };
  }

  /**
   * Merges omp `get_subagents` snapshots into the tracked per-call maps.
   * Snapshots enrich (agent name, mandate, model, narration) and can
   * surface children the event stream never delivered; they never
   * un-finish an entry (events are authoritative for terminal states) and
   * terminal children are absent from snapshots by construction.
   * @param {Array<unknown>} subagents
   * @returns {string|undefined} synthesized update lines (joined) or none
   */
  mergeSnapshots(subagents) {
    const changedCalls = new Map();
    let ownerOut = '';
    for (const snap of subagents) {
      if (!snap || typeof snap !== 'object') continue;
      const childId = typeof snap.id === 'string' && snap.id ? snap.id : null;
      if (!childId) continue;
      const snapStatus = typeof snap.status === 'string' ? snap.status : undefined;
      const callId = this.resolveCallId(
        typeof snap.parentToolCallId === 'string' ? snap.parentToolCallId : null,
        childId
      );
      if (!callId) {
        // FR14/FR19: unattributable snapshot child — withheld from
        // rendering, but registered live (omp lists only live children) so
        // the interrupt sweep still cancels it by id.
        const t = terminalOutcome(snapStatus);
        const observation = {
          status: snapStatus,
          live: !t.finished,
          finished: t.finished,
          stopReason: t.stopReason,
          exitCode: t.exitCode
        };
        const rec = this.registerObserved(childId, null, undefined, observation);
        // A conflicting-parent terminal observation reaches the recorded
        // owner's card too — never only the registry.
        const ownerLine = this.projectTerminalToOwner(rec, childId, observation);
        if (ownerLine) ownerOut += ownerLine;
        continue;
      }
      let calls = this.subagentsByCall.get(callId);
      if (!calls) {
        calls = new Map();
        this.subagentsByCall.set(callId, calls);
      }
      const existed = calls.has(childId);
      // FR15/FR17: same assign-once step rule as the event path, and a
      // pruned-then-re-attached child restores its terminal state instead
      // of resurrecting as running.
      const entry = calls.get(childId)
        ?? this.attachChild(calls, callId, childId, typeof snap.index === 'number' ? snap.index : undefined);
      if (!existed) changedCalls.set(callId, calls);
      // New entries still take name/mandate/model/narration from the
      // snapshot; the change flag only gates re-emission for known ones.
      if (this.applySnapshot(entry, snap, childId)) changedCalls.set(callId, calls);
      this.registerObserved(childId, callId, entry.step, {
        status: snapStatus,
        live: entry.finished !== true,
        finished: entry.finished === true,
        stopReason: entry.stopReason,
        exitCode: entry.exitCode
      });
    }
    if (changedCalls.size === 0) return ownerOut || undefined;
    let out = '';
    for (const [callId, calls] of changedCalls) out += this.synthesizeUpdate(callId, calls);
    return (out + ownerOut) || undefined;
  }

  /**
   * Applies one snapshot record to a tracked entry; returns true when any
   * rendered field changed (gates re-emission).
   * @param {object} entry
   * @param {Record<string, unknown>} snap
   * @param {string} childId
   * @returns {boolean}
   */
  applySnapshot(entry, snap, childId) {
    let changed = false;
    const name = typeof snap.agent === 'string' && snap.agent ? snap.agent : null;
    const agent = name && name !== 'task' ? name : childId;
    if (entry.agent !== agent) {
      entry.agent = agent;
      changed = true;
    }
    const desc = [snap.task, snap.description, snap.assignment]
      .find((t) => typeof t === 'string' && t);
    if (typeof desc === 'string' && desc && entry.task !== desc) {
      entry.task = desc;
      changed = true;
    }
    const progress = snap.progress && typeof snap.progress === 'object' ? snap.progress : {};
    const model = typeof progress.resolvedModelIdentity === 'string' && progress.resolvedModelIdentity
      ? progress.resolvedModelIdentity
      : typeof progress.resolvedModel === 'string' && progress.resolvedModel
        ? progress.resolvedModel : null;
    if (model && entry.model !== model) {
      entry.model = model;
      changed = true;
    }
    if (typeof progress.lastIntent === 'string' && progress.lastIntent) entry._intent = progress.lastIntent;
    if (typeof progress.recentOutput === 'string' && progress.recentOutput) entry._text = progress.recentOutput;
    this.applyStatus(entry, snap.status);
    // Narration precedence identical to the event path (feature 002 FR6).
    const narration = entry.finished
      ? (entry._text ?? entry._intent)
      : (entry._intent ?? entry._text);
    const messages = messagesFromText(narration);
    if (JSON.stringify(entry.messages) !== JSON.stringify(messages)) {
      if (messages) entry.messages = messages;
      changed = true;
    }
    return changed;
  }

  /**
   * Rearranges a claimed tool result so T3's emitSubagentTasks sees one
   * results[] entry per OMP subagent. Mutates and returns true if changed.
   * @param {unknown} record
   * @returns {boolean}
   */
  normalizeTaskRecords(record, callId) {
    if (!record || typeof record !== 'object') return false;
    const details = record.details;
    if (!details || typeof details !== 'object') return false;
    if (!Array.isArray(details.results)) details.results = [];

    let changed = false;
    const known = new Set();
    for (let i = details.results.length - 1; i >= 0; i--) {
      const entry = details.results[i];
      if (!(entry && typeof entry === 'object')) continue;
      const key = String(entry.id ?? entry.index ?? '?');
      known.add(key);
      if (!('__ompT3' in entry)) {
        this.normalizeEntry(entry, true);
        changed = true;
      }
      if (!(callId && typeof entry.id === 'string' && entry.id)) continue;
      // US9/FR15: a known parent contradicting established ownership is a
      // conflict — the duplicate is dropped from the projection (one child,
      // one card), tracked adoption is refused, reconciliation is requested.
      const rec = this.childRegistry.get(entry.id);
      if (rec && rec.ownerCallId && rec.ownerCallId !== callId) {
        details.results.splice(i, 1);
        const observation = {
          status: typeof entry.status === 'string' ? entry.status : undefined,
          live: entry.finished !== true,
          finished: entry.finished === true,
          stopReason: entry.stopReason,
          exitCode: entry.exitCode
        };
        this.registerObserved(entry.id, rec.ownerCallId, rec.step, observation);
        // Terminal outcome reaches the recorded owner's card, not just the
        // registry.
        const ownerLine = this.projectTerminalToOwner(rec, entry.id, observation);
        if (ownerLine) this.pendingOwnerLines.push(ownerLine);
        this.reconciliationNeeded = true;
        changed = true;
        continue;
      }
      // US9/FR19: tool-result children are first-class observations —
      // registry-attributed to the owning call (cancellable by the
      // sweep), with the same frozen-step rule as events and snapshots
      // so the projected frame can never collide with a later card.
      if (this.registerFromToolResult(entry, entry.id, callId, typeof entry.status === 'string' ? entry.status : undefined)) changed = true;
    }

    for (const item of Array.isArray(details.progress) ? details.progress : []) {
      if (!item || typeof item !== 'object') continue;
      const key = String(item.id ?? item.index ?? '?');
      if (known.has(key)) continue;
      known.add(key);
      const entry = this.normalizeEntry(item, false);
      if (callId && typeof item.id === 'string' && item.id) {
        const rec = this.childRegistry.get(item.id);
        if (rec && rec.ownerCallId && rec.ownerCallId !== callId) {
          // Conflicting parent in a live progress item: not projected.
          const observation = {
            status: typeof item.status === 'string' ? item.status : undefined,
            live: entry.finished !== true,
            finished: entry.finished === true,
            stopReason: entry.stopReason,
            exitCode: entry.exitCode
          };
          this.registerObserved(item.id, rec.ownerCallId, rec.step, observation);
          const ownerLine = this.projectTerminalToOwner(rec, item.id, observation);
          if (ownerLine) this.pendingOwnerLines.push(ownerLine);
          this.reconciliationNeeded = true;
          changed = true;
          continue;
        }
      }
      details.results.push(entry);
      changed = true;
      if (callId && typeof item.id === 'string' && item.id) {
        if (this.registerFromToolResult(entry, item.id, callId, typeof item.status === 'string' ? item.status : undefined)) changed = true;
      }
    }

    return changed;
  }

  /**
   * Registers a child observed through a `task` tool result (FR19/FR15):
   * attributed to the frame's own call — the parent reference here is the
   * frame itself, never missing or unverifiable — and ALWAYS merged into
   * the tracked entry, whether or not a frozen step exists. Merging is
   * terminal-sticky (a stale running update never un-finishes a finished
   * child), and the merged terminal state is then projected back into the
   * outgoing frame so a stale observation cannot emit a nonterminal card.
   * The child is mirrored into the per-call map so the interrupt sweep
   * terminalizes its card without re-cancelling completed children.
   * @param {object} entry normalized T3 results[] entry
   * @param {string} childId
   * @param {string} callId
   * @param {string|undefined} status raw omp status of this observation
   * @returns {boolean} true when the projected frame changed
   */
  registerFromToolResult(entry, childId, callId, status) {
    const rec = this.childRegistry.get(childId);
    const frozenStep = rec && rec.ownerCallId && typeof rec.step === 'number'
      ? rec.step
      : undefined;
    let changed = false;
    // The frozen registry step wins over the projected raw index in both
    // directions (a tool update and an event resolve to the same node).
    if (frozenStep !== undefined && entry.step !== frozenStep) {
      entry.step = frozenStep;
      changed = true;
    }
    let calls = this.subagentsByCall.get(callId);
    if (!calls) {
      calls = new Map();
      this.subagentsByCall.set(callId, calls);
    }
    const existed = calls.has(childId);
    const ownIndex = typeof entry.step === 'number' ? entry.step : undefined;
    const mapped = calls.get(childId) ?? this.attachChild(calls, callId, childId, ownIndex);
    // Merge the observation into the tracked entry (fields the tracked
    // entry lacks only — never displacing event-learned narration).
    if (entry.agent && !mapped.agent) mapped.agent = entry.agent;
    if (entry.task && !mapped.task) mapped.task = entry.task;
    if (entry.model && !mapped.model) mapped.model = entry.model;
    if (entry.messages && !mapped.messages) mapped.messages = entry.messages;
    if (entry.step !== mapped.step) {
      // Duplicate/missing index: the projected frame adopts the assigned
      // collision-free step, exactly like the event path.
      entry.step = mapped.step;
      changed = true;
    }
    // Merge with first-terminal-wins stickiness: the terminal outcome
    // (including its flavor — or deliberate absence of one) freezes when
    // the child first reaches a terminal state; a later contradicting
    // observation never overwrites it.
    if (entry.finished === true && mapped.finished !== true) {
      mapped.finished = true;
      if (entry.stopReason !== undefined) mapped.stopReason = entry.stopReason;
      if (entry.exitCode !== undefined) mapped.exitCode = entry.exitCode;
    }
    if (!existed) changed = true;
    // Project the canonical outcome into the outgoing frame ALWAYS when the
    // tracked child is terminal — including when the incoming tool record
    // already says finished:true (a completed record after failed/aborted
    // must not erase stopReason/exitCode from the outgoing card).
    if (mapped.finished === true) {
      if (entry.finished !== true) {
        entry.finished = true;
        changed = true;
      }
      if (entry.stopReason !== mapped.stopReason) {
        if (mapped.stopReason === undefined) delete entry.stopReason;
        else entry.stopReason = mapped.stopReason;
        changed = true;
      }
      if (entry.exitCode !== mapped.exitCode) {
        if (mapped.exitCode === undefined) delete entry.exitCode;
        else entry.exitCode = mapped.exitCode;
        changed = true;
      }
    }
    const finished = mapped.finished === true;
    this.registerObserved(childId, frozenStep !== undefined ? rec.ownerCallId : callId, entry.step, {
      status,
      live: !finished,
      finished,
      stopReason: finished ? mapped.stopReason : undefined,
      exitCode: finished ? mapped.exitCode : undefined
    });
    return changed;
  }

  /**
   * Produces a T3-consumable results[] entry from an OMP progress item, or
   * in-place-normalizes an existing results[] entry.
   */
  normalizeEntry(item, inPlace) {
    const entry = inPlace ? item : {};
    const status = typeof item.status === 'string' ? item.status : undefined;

    if (typeof item.agent === 'string' && item.agent.length > 0) {
      entry.agent = item.agent;
    } else if (typeof item.id === 'string' && item.id.length > 0) {
      entry.agent = item.id;
    } else if (typeof item.index === 'number') {
      entry.agent = `subagent-${item.index}`;
    }
    // omp sometimes reports the child under the TOOL name; T3 titles the
    // subagent node with this string, so "task" would render a card named
    // after the tool instead of the child.
    if (entry.agent === 'task' && typeof item.id === 'string' && item.id.length > 0) {
      entry.agent = item.id;
    }

    if (typeof item.task === 'string' && item.task.length > 0) {
      entry.task = item.task;
    } else if (typeof item.prompt === 'string' && item.prompt.length > 0) {
      entry.task = item.prompt;
    } else if (typeof item.description === 'string' && item.description.length > 0) {
      entry.task = item.description;
    }
    if (entry.task === undefined) entry.task = '';

    if (typeof item.step === 'number') {
      entry.step = item.step;
    } else if (typeof item.index === 'number') {
      entry.step = item.index;
    }

    let finished;
    if (status === 'completed' || status === 'done' || status === 'success') {
      finished = true;
    } else if (status === 'aborted' || status === 'failed' || status === 'error') {
      finished = true;
      if (status === 'aborted') {
        entry.stopReason = 'aborted';
      } else {
        entry.stopReason = 'error';
        if (typeof item.exitCode !== 'number') entry.exitCode = 1;
      }
    }
    if (finished !== undefined && !('finished' in entry)) entry.finished = finished;
    if (typeof item.stopReason === 'string' && entry.stopReason === undefined) {
      entry.stopReason = item.stopReason;
    }
    if (typeof item.exitCode === 'number' && entry.exitCode === undefined) {
      entry.exitCode = item.exitCode;
    }
    if (typeof item.model === 'string' && entry.model === undefined) {
      entry.model = item.model;
    }
    // Feature 002 FR6: project the child's current step narration into the
    // card text T3 renders from messages[]. Only when absent: a finished
    // entry's own result text must not be displaced by a progress snapshot.
    if (typeof item.lastIntent === 'string' && item.lastIntent && entry.messages === undefined) {
      entry.messages = messagesFromText(item.lastIntent);
    }

    return entry;
  }

  /**
   * Live unfinished subagent count across OPEN task calls (feature 002
   * FR4). Sourced from the live-child registry: a child counts while it is
   * believed running (`live`) and its owning task call is still open. When
   * omp ends the parent tool call, detached children stop being countable —
   * callers must treat an empty count as "no authoritative count", not
   * proof that no work is pending. Withheld (unattributed) children have no
   * owning call and are likewise not counted.
   * @returns {number}
   */
  pendingCount() {
    let count = 0;
    for (const rec of this.childRegistry.values()) {
      if (rec.live === true && rec.ownerCallId !== null && this.openCalls.has(rec.ownerCallId)) {
        count += 1;
      }
    }
    return count;
  }
}

module.exports = {
  SubagentBridge
};