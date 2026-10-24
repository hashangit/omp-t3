'use strict';

/**
 * Tracks omp's `task` subagents and renders them as plain tool cards.
 *
 * omp's `task` tool spawns in-process child agents. T3's Pi adapter keys
 * its nested subagent UI on toolName "subagent" + `details.results[]`;
 * feeding omp's quick parallel tasks into that UI mints fake "agent" rows
 * that can never be opened (the adapter hardcodes childThreadId null and
 * omp exposes no child session identity - see
 * specs/002-bridge-ux-parity/subagent-open-gap-report.md). Per AGENTS.md
 * §Subagents, long-running work belongs in T3's delegate_task children;
 * native `task` children are short parallel work and render as what they
 * are: one ordinary tool card per `task` call in the transcript.
 *
 * Rendering: task tool frames pass through byte-identical (no rename, no
 * details rewrite). For every owning call the bridge synthesizes
 * tool_execution_update frames carrying a compact live status line in
 * partialResult.content (child names, short models, step narration,
 * done/live counts), built from omp's subagent_lifecycle/progress/event
 * frames (gated by set_subagent_subscription) and get_subagents
 * snapshots. The raw subagent_* frames are suppressed: T3's adapter
 * ignores unknown event types.
 *
 * Wire correctness beyond rendering (each class pinned by live incidents
 * in the subagent-card era):
 * - live-child registry (FR19): every observed child id, attributed or
 *   not; the interrupt sweep cancels every live child by id.
 * - attribution (FR14): explicit known parent -> recorded owner -> only
 *   task call ever seen -> explicit parent when no task call was seen;
 *   otherwise the update is withheld from rendering while the child stays
 *   registered (ownerCallId null) for the sweep, and reconciliation is
 *   requested. An open task call alone is never proof of ownership: the
 *   last-started-call fallback that minted the incident's phantom cards
 *   stays gone.
 * - `abortSweep()`: on T3 interrupt (upstream abort/abort_and_prompt,
 *   BEFORE any settle synthesis reaches T3), one synthetic
 *   tool_execution_end per OPEN task call closes its card (T3 drops
 *   frames after agent_settled), plus one cancel_subagent per live child
 *   so omp actually hard-kills detached children instead of running them
 *   on invisibly.
 * - `refreshRequest()`/`mergeSnapshots()`: periodic get_subagents
 *   reconciliation (single-flight, rate-limited). omp's snapshot is the
 *   authoritative live child list — it heals missed spawn/lifecycle
 *   events, attributes withheld children, and keeps names, mandates, and
 *   narration current. Snapshots never un-finish an entry: events stay
 *   authoritative for terminal states.
 * - `pendingCount()`: live unfinished children across open calls, feeding
 *   hold-open notices.
 *
 * Bridge-injected RPC ids live in the `ompt3-sub-` namespace; their
 * responses are consumed here and suppressed (T3's adapter would ignore
 * them, but the wire stays clean).
 */
const SUBAGENT_EVENT_TYPES = new Set(['subagent_lifecycle', 'subagent_progress', 'subagent_event']);

/** omp SubagentStatus/SubagentLifecycleStatus values that end a child. */
function isTerminalStatus(status) {
  return status === 'completed' || status === 'done' || status === 'success'
    || status === 'aborted' || status === 'failed' || status === 'error';
}

/**
 * Maps a terminal omp status onto the entry fields it implies. Non-terminal
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
    // parentToolCallId -> Map(id -> tracked entry)
    this.subagentsByCall = new Map();
    // Tool call ids that ever invoked the `task` tool (never pruned), and
    // the OPEN subset (task tool_execution_start adds, end removes).
    // Subagent frames are re-parented here: omp attributes late events
    // (completion during a later `wait`/bash call) to whichever tool is
    // active at that moment, so the frame's explicit parent cannot be
    // trusted alone — attribution follows the registry, not the timeline.
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
    return this.synthesizeStatus(rec.ownerCallId, calls);
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
      // The parent tool call finished: its card is closed, so the per-call
      // child map is dead weight. Children observed in this end frame's
      // result re-attach below (the detached-children shape).
      this.subagentsByCall.delete(parsed.toolCallId);
      this.openCalls.delete(parsed.toolCallId);
    }

    // Observation only: the outgoing frame is NEVER rewritten (toolName
    // stays "task"; omp's own details shape is forwarded as-is). Children
    // seen in result/partialResult feed the registry and the per-call
    // status line; a materially changed call gets its status update
    // appended after the passthrough line.
    this.observeToolRecord(parsed.result, parsed.toolCallId);
    this.observeToolRecord(parsed.partialResult, parsed.toolCallId);
    const taskStarted = this.newTaskCallStarted;
    this.newTaskCallStarted = false;
    const conflict = this.reconciliationNeeded;
    this.reconciliationNeeded = false;
    const ownerLines = this.takePendingOwnerLines();
    return {
      handled: true,
      line: line + '\n' + ownerLines,
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
    // call; late events fired during a later tool (wait, bash) must never
    // attribute a child to that unrelated tool's card.
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

    // FR15: the step fixes the child's display order in the status line,
    // so it is assigned exactly once at first attributed attach and frozen
    // for the child's lifetime (duplicate/missing indices and
    // event/snapshot disagreement must never reshuffle the line). FR17: a
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

    // Narration for the status line: while the child runs, its own step
    // narration (`lastIntent`) wins; recentOutput is the output-tail
    // fallback (feature 002 FR6 precedence, carried into the line).

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

    return { handled: true, line: this.synthesizeStatus(callId, calls) };
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
   * Builds the compact live status line for one task call's children:
   * `<done>/<total> done · running: name (model): note, … · +N` (running
   * children only; finished calls show counts and failures). Each child
   * segment is capped and at most three run inline, so a wide fleet stays
   * one readable line inside the tool card.
   * @param {string} callId
   * @param {Map<string, object>} calls
   * @returns {string} JSONL tool_execution_update line
   */
  statusLine(calls) {
    const kids = [...calls.entries()].sort((a, b) => (a[1].step ?? 0) - (b[1].step ?? 0));
    const done = kids.filter(([, e]) => e.finished === true);
    const live = kids.filter(([, e]) => e.finished !== true);
    const failed = done.filter(([, e]) => e.stopReason !== undefined).length;
    let text;
    if (live.length === 0) {
      text = `${done.length}/${kids.length} done` + (failed > 0 ? ` · ${failed} failed/aborted` : '');
    } else {
      const seg = ([id, e]) => {
        const name = e.agent ?? id;
        const model = typeof e.model === 'string' && e.model ? ` (${e.model.split('/').pop()})` : '';
        const note = e._intent ?? e._text;
        const s = note ? `${name}${model}: ${note}` : `${name}${model}`;
        return s.length > 90 ? `${s.slice(0, 87)}…` : s;
      };
      const shown = live.slice(0, 3).map(seg).join(' · ');
      const more = live.length > 3 ? ` · +${live.length - 3}` : '';
      text = `${done.length}/${kids.length} done · running: ${shown}${more}`;
    }
    return text;
  }

  /**
   * Serializes the tracked children of one task call into the synthesized
   * `tool_execution_update` frame carrying the status line T3 renders in
   * the task tool card (generic Pi convention: partialResult.content text).
   * @param {string} callId
   * @param {Map<string, object>} calls
   * @returns {string}
   */
  synthesizeStatus(callId, calls) {
    return JSON.stringify({
      type: 'tool_execution_update',
      toolCallId: callId,
      toolName: 'task',
      partialResult: { content: [{ type: 'text', text: this.statusLine(calls) }] }
    }) + '\n';
  }

  /**
   * Interrupt path: terminalizes every tracked unfinished child and returns
   * both wire outputs. For T3, one synthetic `tool_execution_end` per OPEN
   * task call closes its card before the settle synthesis (after
   * `agent_settled` the Pi adapter drops every frame, so an open tool card
   * would hang "running" forever). For omp, one `cancel_subagent` request
   * per live child so detached children are hard-killed instead of running
   * on invisibly — mirroring T3's own adapters, which propagate a parent
   * interrupt down to the children. Ended calls' cards are already closed:
   * their re-attached children contribute cancellations only.
   * Called synchronously on the upstream abort line, BEFORE any settle
   * synthesis is written to T3.
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
      for (const [childId, entry] of calls) {
        // Flip registry liveness so the pass below cannot double-cancel,
        // and keep terminal states sticky.
        const rec = this.childRegistry.get(childId);
        if (rec) rec.live = false;
        if (entry.finished === true) continue;
        entry.finished = true;
        if (entry.stopReason === undefined) entry.stopReason = 'aborted';
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
      // Close the card of every OPEN call with tracked children. Ended
      // calls are already closed; their late children die via cancellation.
      // The open-set removal makes the sweep idempotent: a second sweep
      // (or one after a post-abort snapshot) emits nothing.
      if (this.openCalls.has(callId)) {
        this.openCalls.delete(callId);
        toClient.push(JSON.stringify({
          type: 'tool_execution_end',
          toolCallId: callId,
          toolName: 'task',
          result: { content: [{ type: 'text', text: `${this.statusLine(calls)} · interrupted` }] }
        }) + '\n');
      }
    }
    // FR19: withheld (unattributed) children have no owning call, hence no
    // card — they still contribute a cancellation by id so the interrupt
    // hard-kills every observed live child, rendered or not.
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
    for (const [callId, calls] of changedCalls) out += this.synthesizeStatus(callId, calls);
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
    // Narration feeds the status line; a changed non-empty narration
    // re-emits it (same precedence as the event path, feature 002 FR6).
    const narration = (entry._intent ?? entry._text) ?? '';
    if (narration !== '' && narration !== entry._lastNarration) {
      entry._lastNarration = narration;
      changed = true;
    }
    return changed;
  }

  /**
   * Observes children carried by a task tool frame's result/partialResult
   * (details.results[] and details.progress[]). The outgoing frame is never
   * modified — this only feeds the registry, the per-call status line, and
   * (on ownership conflicts) the recorded owner's update, which lands via
   * pendingOwnerLines after the passthrough line.
   * @param {unknown} record
   * @param {string} callId
   * @returns {void}
   */
  observeToolRecord(record, callId) {
    if (!record || typeof record !== 'object') return;
    const details = record.details;
    if (!details || typeof details !== 'object') return;

    const items = [];
    if (Array.isArray(details.results)) items.push(...details.results);
    if (Array.isArray(details.progress)) items.push(...details.progress);
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const obs = this.observeEntry(item);
      const childId = typeof item.id === 'string' && item.id ? item.id : null;
      if (!childId) continue;
      // US9/FR15: a known parent contradicting established ownership is a
      // conflict — adoption is refused, reconciliation is requested, and a
      // terminal observation still reaches the recorded owner.
      const rec = this.childRegistry.get(childId);
      if (rec && rec.ownerCallId && rec.ownerCallId !== callId) {
        this.registerObserved(childId, rec.ownerCallId, rec.step, {
          status: obs.status,
          live: obs.finished !== true,
          finished: obs.finished === true,
          stopReason: obs.stopReason,
          exitCode: obs.exitCode
        });
        const ownerLine = this.projectTerminalToOwner(rec, childId, obs);
        if (ownerLine) this.pendingOwnerLines.push(ownerLine);
        this.reconciliationNeeded = true;
        continue;
      }
      // US9/FR19: tool-result children are first-class observations —
      // registry-attributed to the frame's own call (cancellable by the
      // sweep) and merged into the per-call map with the same frozen-step
      // rule as events and snapshots.
      this.registerFromToolResult(obs, childId, callId);
    }
  }

  /**
   * Registers a child observed through a `task` tool frame (FR19/FR15):
   * attributed to the frame's own call — the parent reference here is the
   * frame itself, never missing or unverifiable — and merged into the
   * tracked entry with first-terminal-wins stickiness (a stale running
   * update never un-finishes a finished child). The child is mirrored
   * into the per-call map so the status line and the interrupt sweep see
   * it; when the merge materially changed the call's entries, one status
   * update is appended for that call.
   * @param {object} obs observeEntry() projection of the raw item
   * @param {string} childId
   * @param {string} callId
   * @returns {void}
   */
  registerFromToolResult(obs, childId, callId) {
    const rec = this.childRegistry.get(childId);
    const frozenStep = rec && rec.ownerCallId && typeof rec.step === 'number'
      ? rec.step
      : undefined;
    let calls = this.subagentsByCall.get(callId);
    if (!calls) {
      calls = new Map();
      this.subagentsByCall.set(callId, calls);
    }
    const existed = calls.has(childId);
    const ownIndex = typeof obs.step === 'number' ? obs.step : undefined;
    const mapped = calls.get(childId) ?? this.attachChild(calls, callId, childId, ownIndex);
    // Merge the observation into the tracked entry (fields the tracked
    // entry lacks only — never displacing event-learned narration).
    let changed = !existed;
    if (obs.agent && !mapped.agent) mapped.agent = obs.agent;
    if (obs.task && !mapped.task) mapped.task = obs.task;
    if (obs.model && !mapped.model) mapped.model = obs.model;
    if (typeof obs.lastIntent === 'string' && obs.lastIntent && mapped._intent !== obs.lastIntent) {
      mapped._intent = obs.lastIntent;
      changed = true;
    }
    // Merge with first-terminal-wins stickiness: the terminal outcome
    // (including its flavor — or deliberate absence of one) freezes when
    // the child first reaches a terminal state; a later contradicting
    // observation never overwrites it.
    if (obs.finished === true && mapped.finished !== true) {
      mapped.finished = true;
      if (obs.stopReason !== undefined) mapped.stopReason = obs.stopReason;
      if (obs.exitCode !== undefined) mapped.exitCode = obs.exitCode;
      changed = true;
    }
    this.registerObserved(childId, frozenStep !== undefined ? rec.ownerCallId : callId, mapped.step, {
      status: obs.status,
      live: mapped.finished !== true,
      finished: mapped.finished === true,
      stopReason: mapped.finished === true ? mapped.stopReason : undefined,
      exitCode: mapped.finished === true ? mapped.exitCode : undefined
    });
    if (changed) this.pendingOwnerLines.push(this.synthesizeStatus(callId, calls));
  }

  /**
   * Projects a raw OMP progress/results item onto a plain observation
   * record: { agent, task, model, step, status, finished, stopReason,
   * exitCode, lastIntent }. Never mutates the item.
   */
  observeEntry(item) {
    const obs = {};
    const status = typeof item.status === 'string' ? item.status : undefined;
    obs.status = status;

    if (typeof item.agent === 'string' && item.agent.length > 0) {
      obs.agent = item.agent;
    } else if (typeof item.id === 'string' && item.id.length > 0) {
      obs.agent = item.id;
    } else if (typeof item.index === 'number') {
      obs.agent = `subagent-${item.index}`;
    }
    // omp sometimes reports the child under the TOOL name; the status line
    // would then name the child after the tool instead of the child.
    if (obs.agent === 'task' && typeof item.id === 'string' && item.id.length > 0) {
      obs.agent = item.id;
    }

    if (typeof item.task === 'string' && item.task.length > 0) {
      obs.task = item.task;
    } else if (typeof item.prompt === 'string' && item.prompt.length > 0) {
      obs.task = item.prompt;
    } else if (typeof item.description === 'string' && item.description.length > 0) {
      obs.task = item.description;
    }

    if (typeof item.step === 'number') {
      obs.step = item.step;
    } else if (typeof item.index === 'number') {
      obs.step = item.index;
    }

    const t = terminalOutcome(status);
    if (t.finished) {
      obs.finished = true;
      if (t.stopReason !== undefined) obs.stopReason = t.stopReason;
      if (t.exitCode !== undefined && typeof item.exitCode !== 'number') obs.exitCode = t.exitCode;
    }
    if (typeof item.stopReason === 'string' && obs.stopReason === undefined) {
      obs.stopReason = item.stopReason;
    }
    if (typeof item.exitCode === 'number' && obs.exitCode === undefined) {
      obs.exitCode = item.exitCode;
    }
    if (typeof item.model === 'string') {
      obs.model = item.model;
    }
    if (typeof item.lastIntent === 'string' && item.lastIntent) {
      obs.lastIntent = item.lastIntent;
    }

    return obs;
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