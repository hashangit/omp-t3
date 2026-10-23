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
 *   authoritative live child list — it heals missed spawn/lifecycle events
 *   and keeps names, mandates, and narration current. Snapshots never
 *   un-finish an entry: events stay authoritative for terminal states.
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
class SubagentBridge {
  constructor() {
    // parentToolCallId -> Map(id -> T3 results entry)
    this.subagentsByCall = new Map();
    // Tool call ids that invoked the `task` tool, and the most recent one.
    // Subagent frames are re-parented here: omp attributes late events
    // (completion during a later `wait`/bash call) to whichever tool is
    // active at that moment, which would split one child into several T3
    // nodes keyed `${parentToolCallId}:subagent:${step}` - one of them then
    // never terminates and T3's tree shows "Waiting on background task
    // subagent" forever.
    this.taskCalls = new Set();
    this.activeTaskCall = null;
    // Bridge-injected RPC state (ompt3-sub- id namespace): sequence counter
    // plus single-flight/rate-limit state for get_subagents reconciliation.
    this.seq = 0;
    this.refreshPending = false;
    this.lastRefreshAt = 0;
    this.refreshMinIntervalMs = 1000;
    // Transient flag: handleDownstreamFrame sets it when a NEW task tool
    // call starts; the proxy reads it to trigger get_subagents refresh.
    this.newTaskCallStarted = false;
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
      this.activeTaskCall = parsed.toolCallId;
      if (isNew) this.newTaskCallStarted = true;
    }

    if (!invoked) return { handled: false };

    if (parsed.type === 'tool_execution_end' && parsed.toolCallId) {
      // The parent tool call finished: T3 forces its entries finished, so the
      // per-call child map is dead weight from here on.
      this.subagentsByCall.delete(parsed.toolCallId);
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

    if (this.normalizeTaskRecords(parsed.result)) modified = true;
    if (this.normalizeTaskRecords(parsed.partialResult)) modified = true;
    const taskStarted = this.newTaskCallStarted;
    this.newTaskCallStarted = false;
    return {
      handled: true,
      line: modified ? JSON.stringify(parsed) + '\n' : line + '\n',
      ...(taskStarted ? { taskStarted: true } : {})
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
    // Trust omp's explicit parent only when it is actually a `task` tool
    // call; late events fired during a later tool (wait, bash) would
    // otherwise spawn a second, never-terminating T3 node under that tool.
    // If no task call was ever seen (e.g. the shim attached mid-turn), anchor
    // to the explicit parent rather than dropping the card entirely.
    const callId = this.resolveCallId(typeof payload.parentToolCallId === 'string' ? payload.parentToolCallId : null);
    if (!callId) return { handled: true }; // suppress: nothing to attach to

    let calls = this.subagentsByCall.get(callId);
    if (!calls) {
      calls = new Map();
      this.subagentsByCall.set(callId, calls);
    }

    // Identify the child: lifecycle/event use payload.id; progress nests it
    // in payload.progress.id. Index and text live at different depths too.
    const nested = payload.progress && typeof payload.progress === 'object' ? payload.progress : {};
    const id = typeof payload.id === 'string' && payload.id
      ? payload.id
      : (typeof nested.id === 'string' && nested.id ? nested.id : null);
    if (!id) return { handled: true };

    let entry = calls.get(id);
    if (!entry) {
      entry = {
        agent: undefined,
        task: '',
        step: typeof payload.index === 'number' ? payload.index
          : typeof nested.index === 'number' ? nested.index : undefined,
        finished: false
      };
      calls.set(id, entry);
    }

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
      const event = payload.event && typeof payload.event === 'object' ? payload.event : {};
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

    return { handled: true, line: this.synthesizeUpdate(callId, calls) };
  }

  /**
   * Resolves which `task` tool call owns a child frame/snapshot. Trusts
 * omp's explicit parent only when it is a known task call; late events
 * fired during a later tool (wait, bash) must not steal ownership. With no
 * task call ever seen (shim attached mid-run), anchors to the explicit
 * parent rather than dropping the card entirely.
   * @param {string|null} explicit
   * @returns {string|null}
   */
  resolveCallId(explicit) {
    if (explicit && this.taskCalls.has(explicit)) return explicit;
    if (this.activeTaskCall) return this.activeTaskCall;
    return this.taskCalls.size === 0 ? explicit : null;
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
    if (status === 'completed' || status === 'done' || status === 'success') {
      entry.finished = true;
    } else if (status === 'aborted') {
      entry.finished = true;
      entry.stopReason = 'aborted';
    } else if (status === 'failed' || status === 'error') {
      entry.finished = true;
      entry.stopReason = 'error';
      if (entry.exitCode === undefined) entry.exitCode = 1;
    }
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
    for (const [callId, calls] of this.subagentsByCall) {
      let touched = false;
      for (const [childId, entry] of calls) {
        if (entry.finished === true) continue;
        entry.finished = true;
        if (entry.stopReason === undefined) entry.stopReason = 'aborted';
        touched = true;
        toOmp.push(JSON.stringify({
          id: `ompt3-sub-${++this.seq}`,
          type: 'cancel_subagent',
          subagentId: childId
        }) + '\n');
      }
      if (touched) toClient.push(this.synthesizeUpdate(callId, calls));
    }
    return { toClient, toOmp };
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
    for (const snap of subagents) {
      if (!snap || typeof snap !== 'object') continue;
      const childId = typeof snap.id === 'string' && snap.id ? snap.id : null;
      if (!childId) continue;
      const callId = this.resolveCallId(
        typeof snap.parentToolCallId === 'string' ? snap.parentToolCallId : null
      );
      if (!callId) continue;
      let calls = this.subagentsByCall.get(callId);
      if (!calls) {
        calls = new Map();
        this.subagentsByCall.set(callId, calls);
      }
      let entry = calls.get(childId);
      if (!entry) {
        entry = {
          agent: undefined,
          task: '',
          step: typeof snap.index === 'number' ? snap.index : undefined,
          finished: false
        };
        calls.set(childId, entry);
        changedCalls.set(callId, calls);
      }
      // New entries still take name/mandate/model/narration from the
      // snapshot; the change flag only gates re-emission for known ones.
      if (this.applySnapshot(entry, snap, childId)) changedCalls.set(callId, calls);
    }
    if (changedCalls.size === 0) return undefined;
    let out = '';
    for (const [callId, calls] of changedCalls) out += this.synthesizeUpdate(callId, calls);
    return out || undefined;
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
  normalizeTaskRecords(record) {
    if (!record || typeof record !== 'object') return false;
    const details = record.details;
    if (!details || typeof details !== 'object') return false;
    if (!Array.isArray(details.results)) details.results = [];

    let changed = false;
    const known = new Set();
    for (const entry of details.results) {
      if (entry && typeof entry === 'object') {
        const key = String(entry.id ?? entry.index ?? '?');
        known.add(key);
        if (!('__ompT3' in entry)) {
          this.normalizeEntry(entry, true);
          changed = true;
        }
      }
    }

    for (const item of Array.isArray(details.progress) ? details.progress : []) {
      if (!item || typeof item !== 'object') continue;
      const key = String(item.id ?? item.index ?? '?');
      if (known.has(key)) continue;
      known.add(key);
      details.results.push(this.normalizeEntry(item, false));
      changed = true;
    }

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
   * Live unfinished subagent count across all open task calls (feature 002
   * FR4). Authoritative only while the owning task tool call is still open:
   * when omp ends the parent tool call, late children are forced finished and
   * the per-call map is dropped, so callers must treat an empty count as "no
   * authoritative count", not proof that no work is pending.
   * @returns {number}
   */
  pendingCount() {
    let count = 0;
    for (const calls of this.subagentsByCall.values()) {
      for (const entry of calls.values()) {
        if (entry.finished !== true) count += 1;
      }
    }
    return count;
  }
}

module.exports = {
  SubagentBridge
};