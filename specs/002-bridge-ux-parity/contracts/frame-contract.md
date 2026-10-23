# Frame Contract — Round 2 additions

Extends [feature 001's RPC contract](../../001-omp-t3-translator/contracts/rpc-contract.md). Existing frame shapes, settlement semantics, and the byte-passthrough invariant are **unchanged**. All additions are downstream-only (bridge → T3); nothing new is sent upstream to omp.

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

Contract with the consumer (evidence: Pi adapter reads exactly `agent, task, step, finished, stopReason, exitCode, model, messages[]`):

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
