# Frame Contract — Round 2 additions

Extends [feature 001's RPC contract](../../001-omp-t3-translator/contracts/rpc-contract.md). Existing frame shapes, settlement semantics, and the byte-passthrough invariant are **unchanged**. Round-2 additions are downstream-only; the round-3 subagent stop/reconciliation additions (§5) additionally inject two omp-native requests upstream (`cancel_subagent`, `get_subagents`) under the bridge's own `ompt3-sub-` id namespace.

## 1. Notice frames (FR4 hold-open, FR5 drift)

Channel decision (corrected in implementation review against the extracted T3 0.1.2 adapter source): the only consumer-visible in-thread notice channel is `extension_ui_request` with `method: "notify"` — the same frame omp's extension `ctx.ui.notify` emits. The adapter's notify branch projects it directly into a `system_notice` turn item (`turn !== null` is the gate: with no active turn the notify is dropped — which is why FR5 notices are wired to the settle-synthesis path only, written immediately BEFORE the synthesized `agent_settled`). There is **no** `tool_execution` handler in the consumer; an earlier draft's `tool_execution`/`notify` tool-call framing was dropped (it would render a tool card with fake output, a look-alike rather than a notice).

Wire shape (finalized + pinned by tests; verified live against T3 0.1.2):

```json
{"type":"extension_ui_request","id":"ompt3-notice-<n>","method":"notify",
 "message":"<human text>","notifyType":"info"}
```

Rules:
- `id` namespace `ompt3-notice-` (mirrors 001's `ompt3-cmds-` convention); `<n>` from the bridge's notice counter. T3's notify path ignores `id`, but uniqueness aids log correlation.
- `message` is always non-empty (the consumer rejects empty notify messages).
- Hold-open text: `Run held open: N pending subagent(s)` when the subagent count is authoritative (live unfinished entries across open task calls — `SubagentBridge.pendingCount()`), else `Run held open: pending background work` (omp exposes work pending only as `get_state.hasPendingAsyncWork`)`. Never invents counts.
- Drift text: `omp-t3 contract drift: <drift title>` — one source of truth, two sinks (stderr rollback banner + in-thread notice).
- Rate limits: at most one hold-open notice per hold interval, re-emit only when the pending signature (`subagents:<n>` | `background`) changes, cleared when the run settles; drift notices share the doctor's 24h per-signature ledger (rate-limited report → no in-thread notice).
- Notices carry **no settlement semantics**: they never synthesize or delay `agent_settled`, and `settlement.js` stays the single settle point. Both notice kinds are emitted only from mid-run paths; a notice before a settle is ordered notify → settle (pinned in the doctor test).
- Older consumers drop unknown event types (verified 001 §3) — worst case is a missing notice, never a broken turn.

## 2. Subagent entries (FR6) — unchanged shape, richer text

- Status mapping pins: omp `SubagentStatus`/`SubagentLifecycleStatus` `completed|done|success` → `finished:true`; `aborted` → `finished:true, stopReason:"aborted"` (T3 renders `interrupted`); `failed|error` → `finished:true, stopReason:"error", exitCode:1` (T3 renders `failed`). `SubagentLifecyclePayload` carries the mandate as `description` (no `task` field); the bridge falls back through `task` → `description` → `assignment`. Terminal states stick: later snapshots never un-finish an entry (events are authoritative for terminals).

```json
{"type":"tool_execution_update","toolCallId":"<taskCallId>","toolName":"subagent",
 "partialResult":{"details":{"results":[{"agent":"…","task":"…","step":"…",
    "finished":false,"stopReason":null,"exitCode":null,"model":"…","messages":[…]}]}}}
```

- US4 narration precedence (projected into `messages[]` only; no schema change): while the child runs, omp 18.12.3+ step narration (`progress[].lastIntent` and subagent_progress `payload.progress.lastIntent`) wins; once finished, the latest assistant text from `subagent_event` wins; `recentOutput` remains the fallback in both cases; entries without narration emit exactly as before. Bounds unchanged (progress text effectively ≤ 200 chars rendered, final ≤ 10 000).
- No identity fields added (adapter hardcodes `childThreadId: null`, ignores unknown fields — see [../subagent-open-gap-report.md](../subagent-open-gap-report.md)). Revisit only after the upstream T3 change lands.

## 3. Approval-mode interaction — CUT

Cut in review: T3 has no in-thread approval-confirm suppression path the bridge could dedupe, so enabling omp's cross-session approval cache would add prompts, not remove them. No bridge change; the upstream ask stays in [../research.md](../research.md) R3. Approval dialogs keep working exactly as in 001 (`extension_ui_request`: select/confirm passthrough, pinned by `test/approval.test.js`).

## 4. Settlement & compaction pins (FR10, FR11) — no shape changes

Pins assert existing behavior against new upstream timing:
- FR10: `auto_compaction_start/end` arriving after `session_settled` was translated → pair still translates, no second `agent_settled`, no reopen, next prompt still settles from `session_settled` (omp 18.12.2 moved idle compaction to ~54-min TTL; 18.12.6 skips Codex caches).
- FR11: rollback/fork across a compacted session → `switch_session`/`fork` upstream and `get_entries` responses cross the pipeline byte-identically (T3 0.1.2 boundary rework + omp 18.12.4 branch-resume fixes; history integrity is omp's, not the bridge's).

## 5. Subagent stop & reconciliation (round 3)

Incident (2026-10-23, thread `5fd61a7a`): a T3 interrupt finalized the run while 10 provider-native subagent rows stayed `status: running` in T3's orchestration DB forever. Root cause is consumer-side and verified in the T3 0.1.2 Pi adapter: `finalizeTurn` runs on `agent_settled` **without sweeping open subagent rows**, and every later `tool_execution_update` is dropped (`turn === null`). omp-side, detached children of the aborted run kept executing with no owner. The bridge closes both sides, mirroring how T3's own Codex adapter propagates a parent interrupt down to child turns:

### 5.1 Interrupt translation (T3 → omp)

On an upstream `abort`/`abort_and_prompt`, `SettlementTracker.onAbort` fires **synchronously inside the abort branch, before any settle synthesis is written to T3** (`settlement.js` returns the idle-abort `agent_settled` only after the hook ran; the active-cycle settle follows `agent_end`, also later). Ordering is the whole point: T3's `interruptTurn` sets `turn.interrupted = true` before sending `abort`, so the turn still accepts frames — the synthesized terminal updates land in the one window where they cannot become zombies.

`SubagentBridge.abortSweep()` returns:

- **toClient**: one `tool_execution_update` per open task call that had live children — every entry `finished:true, stopReason:"aborted"` (T3 maps to `interrupted`). Entries already terminal keep their own state.
- **toOmp**: one `{"id":"ompt3-sub-<n>","type":"cancel_subagent","subagentId":<id>}` per live child, written before the forwarded `abort` — omp hard-kills detached children (`data.cancelled:boolean`; `false` when not running, so racing synchronous children are harmless). Verified live against omp 18.12.6.

No tracked children → both lists empty → zero wire change (bare aborts behave exactly as before, pinned by the pre-existing abort tests).

### 5.2 Reconciliation (omp → T3 details)

omp's `get_subagents` response (`data.subagents[]`, `SubagentSnapshot[]`) is the authoritative live child list. The bridge requests it (single-flight, ≥1s rate limit, `ompt3-sub-` id) when:

1. the `set_subagent_subscription` response arrives (subscription live — seed children spawned before it),
2. a **new** `task` tool call starts (`taskStarted` flag on the subagent bridge result),
3. each hold-open tick fires (settlement withheld for pending work).

Snapshots merge by `id` under the same parent-attribution rules as events (explicit `parentToolCallId` only when it is a known task call; else `activeTaskCall`; else the explicit parent when no task call was ever seen). They enrich `agent`, `task`, `model` (`progress.resolvedModelIdentity` → `resolvedModel`), and narration (`progress.lastIntent`/`recentOutput` under the FR6 precedence), surface children the event stream never delivered, and never un-finish entries. Unchanged snapshots re-emit nothing. All `ompt3-sub-*` responses are consumed and suppressed — never forwarded to T3.
