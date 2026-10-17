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
      this.taskCalls.add(parsed.toolCallId);
      this.activeTaskCall = parsed.toolCallId;
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
    return { handled: true, line: modified ? JSON.stringify(parsed) + '\n' : line + '\n' };
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
    const explicit = typeof payload.parentToolCallId === 'string' ? payload.parentToolCallId : null;
    const callId = explicit && this.taskCalls.has(explicit)
      ? explicit
      : this.activeTaskCall ?? (this.taskCalls.size === 0 ? explicit : null);
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
      const desc = typeof nested.task === 'string' && nested.task ? nested.task : payload.task;
      if (typeof desc === 'string' && desc) entry.task = desc;
      if (payload.status === 'completed') {
        entry.finished = true;
      } else if (payload.status === 'aborted') {
        entry.finished = true;
        entry.stopReason = 'aborted';
      }
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
      if (nested.status === 'completed') entry.finished = true;
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

    // piSubagentOutput reads messages[] for progress/result text.
    const messages = messagesFromText(entry._text);
    if (messages) entry.messages = messages;

    const results = [...calls.entries()]
      .sort((a, b) => (a[1].step ?? 0) - (b[1].step ?? 0))
      .map(([, e]) => {
        const out = {};
        out.agent = e.agent ?? id;
        out.task = e.task ?? '';
        if (e.step !== undefined) out.step = e.step;
        out.finished = e.finished;
        if (e.stopReason !== undefined) out.stopReason = e.stopReason;
        if (e.exitCode !== undefined) out.exitCode = e.exitCode;
        if (e.model !== undefined) out.model = e.model;
        if (e.messages !== undefined) out.messages = e.messages;
        return out;
      });

    const synthesized = JSON.stringify({
      type: 'tool_execution_update',
      toolCallId: callId,
      toolName: 'subagent',
      partialResult: { content: [], details: { results } }
    }) + '\n';
    return { handled: true, line: synthesized };
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

    return entry;
  }
}

module.exports = {
  SubagentBridge
};