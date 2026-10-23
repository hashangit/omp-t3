# Data Model: Bridge Hardening & UX Parity Round

Extends the TranslatorState model from [feature 001](../../001-omp-t3-translator/data-model.md). Existing entities (SessionFrame, TranslatorState, SubagentStateMap, CommandCatalogEntry, PrunedModel, ContractState) are unchanged except where noted.

## New entities

### HoldOpenNotice

Emitted when a run is held open by pending work (settlement withheld).

| Field | Type | Rules |
|---|---|---|
| `pendingSubagents` | number ≥ 0 | From the subagent bridge's live count (`pendingCount()` — unfinished entries across open task calls); 0 when no task call is open |
| `countAuthoritative` | boolean | `true` iff `pendingSubagents > 0`; `false` → text says "pending background work" (omp exposes work pending only as the `get_state.hasPendingAsyncWork` boolean, never counts) |
| `lastSignature` | string | `subagents:<n>` \| `background` — evaluate on each withheld signal; emit only when it changes |

State transitions: `withheld-settlement observed` (prompt_result `agentInvoked:true, sessionSettled:false`, or get_state probe `hasPendingAsyncWork:true`) → `signature != lastSignature?` → emit; `session_settled translated` → hold over (signature reset; no close-out frame — the settlement itself finalizes the run). The count is authoritative only while the owning task tool call is open: when omp ends it, late children are forced finished and their maps are dropped (hence the honest fallback text).

Implementation note: the notice frame builder and the tracker live in `src/notices.js` (`notifyFrame`, `holdOpenText`, `HoldOpenTracker`); the settlement tracker exposes `onHoldOpen`/`pendingSubagents` hooks the proxy wires to the tracker and the subagent bridge — the tracker itself stays settle-only.

### DriftNotice

| Field | Type | Rules |
|---|---|---|
| `signature` | string | Same ledger key as doctor issue filing (`settle-missing:<ompVersion>`, `discovery-failed:<ompVersion>:<reason>`) |
| `side` | enum | `omp` \| `t3` \| `bridge` |
| `title` | string ≤ 200 chars | Human-readable intervention summary; also becomes the in-thread notice text (`omp-t3 contract drift: <title>`) |
| `firstSeenAt` | timestamp | From existing doctor ledger — notices reuse it, never double-report an open signature |

Shares the rate-limit ledger with `ContractDoctor.issuesFiled` — an in-thread notice and a filed issue are one report, not two. In-thread rendering is wired ONLY for watchdog settlement synthesis (`report(drift, { notify: true })` written synchronously before the synthesized settle); discovery failures remain off-thread (no turn exists yet, the consumer drops notices anyway).

### ApprovalMode, SessionContinuation — CUT

Cut in review: the approval cache cannot help without a consumer-side suppression path (spec History), and session continuation is native omp behavior (pure passthrough, FR1 pin). No entities, no launch flags, no state.

## Extended entities

### SubagentEntry — narration projection (US4)

R1 verdict: the consumer reads only `agent, task, step, finished, stopReason, exitCode, model, messages[]` and hardcodes `childThreadId: null`. No new fields (see [subagent-open-gap-report.md](./subagent-open-gap-report.md)). What changes is only the text inside `messages[]`:

- Internal (never serialized) entry fields: `_intent` (latest `lastIntent`), `_text` (latest `recentOutput`/assistant event text).
- Projection rule: running → `_intent ?? _text`; finished → `_text ?? _intent` (final assistant text first); absent → emit as before, byte-compatible.
- Task-tool `progress[]` items project `lastIntent` into `messages[]` only when the entry lacks any (no displacement of result text).
- Bounds unchanged (progress ≤ 200 chars rendered, final ≤ 10 000).

### TranslatorState additions

| Field | Purpose |
|---|---|
| `holdOpen: HoldOpenTracker` | Live hold state during a withheld-settlement interval (proxy-wired) |
| `noticeCounter: number` | Monotonic id source for synthesized notice frames (`ompt3-notice-<n>`), per Process |
| `deferralLedger read` | `--check` only: node:sqlite probe of omp's `agent.db` `cache` table (no proxy-state change) |

### ContractState (doctor, on disk) — unchanged schema

`issuesFiled` ledger gains a second consumer (in-thread notices) — same keys, same 24h rate limit, updated at the same report instant. No migration.

## Frame vocabulary added (downstream → consumer)

One synthesized frame kind, additive and ignored-by-older-consumers in the worst case (T3 drops unknown event types — verified feature 001 §3):

1. **Notice frame** (hold-open + drift): `{"type":"extension_ui_request","id":"ompt3-notice-<n>","method":"notify","message":"<text>","notifyType":"info"}` — omp's own notify shape, projected by T3 0.1.2 to a `system_notice` turn item while a turn is active. (Corrected in review: there is no `tool_execution` handler; the earlier `dynamic_tool` draft is dead.)
2. **No settlement-semantics frames added.** Notices never carry settle/open implications; `settlement.js` remains the single settle point.
