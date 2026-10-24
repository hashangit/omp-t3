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

### 5.0 Rendering pivot (1.4.0-1): task cards, not subagent cards

Supersedes the *rendering* halves of §5.1–§5.4 (the attribution, registry, reconciliation, and cancellation machinery is unchanged and remains load-bearing). omp's `task` children are quick parallel workers, not openable agent sessions — feeding them into T3's subagent UI (`toolName:"subagent"` + `details.results[]`) rendered fake agent rows that could never be opened (the Pi adapter hardcodes `childThreadId: null`; see [../subagent-open-gap-report.md](../subagent-open-gap-report.md)) and whose per-child node keys (`${toolCallId}:subagent:${step}`) were the root of the phantom-row and zombie-row bug classes. As of 1.4.0-1:

- `task` tool frames pass through **byte-identical**: no rename, no `details` rewrite. One `task` call renders as one ordinary tool card in the transcript.
- The bridge synthesizes `tool_execution_update` frames with `toolName:"task"` carrying a compact live status line in `partialResult.content` (`<done>/<total> done · running: name (model): note, … · +N`, capped), built from `subagent_*` events and `get_subagents` snapshots.
- The interrupt sweep closes every **open** task card with one synthetic `tool_execution_end` (`<status line> · interrupted`) instead of per-child terminal updates; ended calls' cards are already closed, so their late children contribute cancellations only — the zombie class is structurally gone (a generic tool card cannot outlive its call's end frame).
- Long-running delegated work belongs in T3's `delegate_task` children (openable threads, own scopes), per AGENTS.md §Subagents; the subagent UI is reserved for exactly those.

### 5.1 Interrupt translation (T3 → omp)

On an upstream `abort`/`abort_and_prompt`, `SettlementTracker.onAbort` fires **synchronously inside the abort branch, before any settle synthesis is written to T3** (`settlement.js` returns the idle-abort `agent_settled` only after the hook ran; the active-cycle settle follows `agent_end`, also later). Ordering is the whole point: T3's `interruptTurn` sets `turn.interrupted = true` before sending `abort`, so the turn still accepts frames — the synthesized terminal updates land in the one window where they cannot become zombies.

`SubagentBridge.abortSweep()` returns:

- **toClient** (§5.0 shape): one synthetic `tool_execution_end` per **open** task call — tracked children or not (an open card in the task-start→first-child window must not survive the interrupt; a childless call closes with `0/0 done · interrupted`). `toolName:"task"`, result content `<status line> · interrupted`. The card cannot outlive the interrupt — post-`agent_settled` frames are dropped, so this is the only window to close it; the sweep removes the call from the open set as it closes it, making a second sweep a no-op. Ended calls' cards are already closed and accept no further rendering (all status emissions are gated on open calls — §5.0 repair round): their re-attached children (the detached-children shape — omp ends the parent's task calls while the children keep running; live-verified 2026-10-23, interrupt 14s after the calls ended with six children detached) live in the registry and die via the `toOmp` cancellation below. Entries already terminal keep their own state in the closing summary.
- **toOmp**: one `{"id":"ompt3-sub-<n>","type":"cancel_subagent","subagentId":<id>}` per live child, written before the forwarded `abort` — omp hard-kills detached children (`data.cancelled:boolean`; `false` when not running, so racing synchronous children are harmless). Verified live against omp 18.12.6.

No observed children — per-call maps and the live-child registry both empty — means both lists stay empty → zero wire change (bare aborts behave exactly as before, pinned by the pre-existing abort tests). Withheld (unattributed) children contribute cancellations only: no owning call exists, so there is no card update for them (§5.3, FR19).

### 5.2 Reconciliation (omp → T3 details)

omp's `get_subagents` response (`data.subagents[]`, `SubagentSnapshot[]`) is the authoritative live child list. The bridge requests it (single-flight, ≥1s rate limit, `ompt3-sub-` id) when:

1. the `set_subagent_subscription` response arrives (subscription live — seed children spawned before it),
  * a **new** `task` tool call starts (`taskStarted` flag on the subagent bridge result),
  * each hold-open tick fires (settlement withheld for pending work).

Snapshots merge by `id` under the attribution rule in §5.3. They enrich `agent`, `task`, `model` (`progress.resolvedModelIdentity` → `resolvedModel`), and narration (`progress.lastIntent`/`recentOutput` under the FR6 precedence), surface children the event stream never delivered, and never un-finish an entry. Unchanged snapshots re-emit nothing. All `ompt3-sub-*` responses are consumed and suppressed — never forwarded to T3. Terminal state also survives per-call map pruning: an entry deleted when its task call ended is re-attached from the registry's recorded outcome (`finished`/`stopReason`/`exitCode`) — a late running snapshot restores the child terminal instead of resurrecting it as running (round-4 follow-up; same for entries terminalized by the sweep).

### 5.3 Attribution rule (round 4 — target state; US9/FR14–FR15/FR19, review-hardened)

Both event frames and snapshots resolve the owning task call by the same ordered rule:

1. explicit `parentToolCallId` that is a **known task call** (open or ended — a late completion arriving during a later `wait`/`bash` lands on its true parent) — **unless it conflicts with rule 2's recorded owner**;
2. else a **child id the bridge has already attributed** → its recorded owner (registry-first: once a child has an owner, later parentless frames follow the child, not the call timeline). **Ownership is not renegotiated**: a known explicit parent that CONTRADICTS the recorded owner resolves to nothing — the update is withheld (no second card under the other parent), the recorded owner stands, and reconciliation is requested;
3. else the **only task call ever seen** in the session (single-call runs, open or ended — the pinned parentless-frame behavior);
4. else, when **no task call was ever seen**, the explicit parent (mid-turn attach);
5. otherwise the update is **ambiguous** — more than one task call exists in the session's history and the child is unknown with no usable explicit parent. **An open task call alone is never proof of ownership**: the late orphan (parent A's call ended, call B open, A's unknown child reports parentless) lands under no call.

Ambiguous updates are **withheld from rendering** (no card is minted) and a reconciliation refresh is requested; the authoritative snapshot then attributes the child from stronger evidence (snapshots carry explicit parents), or the child stays unrendered. Withheld children are not invisible to the lifecycle: every observed child id — attributed or not — is recorded in the **live-child registry** with its observed status, and the interrupt sweep (§5.1) cancels every live registry entry by id (FR19). Scope of the guarantee: misattributed *rendering* is structurally impossible — a child the bridge cannot attribute is unrendered, never misrendered, and still cancelled.

**Canonical outcome across channels** (round-4 follow-up): the registry record is the single source of truth for a child's lifecycle outcome, and a terminal observation reaches the recorded owner's rendered card even when the observation itself renders nowhere — a conflicting-parent completion terminalizes the owner's card (with its own outcome flavor) before any settle, so conflict handling can never leave a running card behind. The outcome is first-terminal-wins per child: once terminal, no later observation (running progress, contradicting tool record, snapshot) un-finishes, re-cancels, or re-flavors it.

### 5.4 Stable projected step (round 4; FR15 — display order since §5.0)

**Tool-result observations share the rule** (round-4 follow-up): children reported in a `task` tool call's `results[]`/`progress[]` are registered like any other observation — attributed to the frame's own call (the parent reference there is the frame itself, never missing or unverifiable), step-assigned by the same rule, and mirrored into the per-call map so the sweep terminalizes their cards. The observation is **always merged** into the tracked child, frozen step or not; merging is terminal-sticky and **first-terminal-wins** — the outcome flavor (including a deliberate absence of one) freezes at the first terminal observation, and the canonical state is projected back into the outgoing frame unconditionally once the child is terminal, so a stale running update cannot emit a nonterminal card and a later completed record after failed/aborted cannot erase `stopReason`/`exitCode` (a contradicting flavor is stripped from the frame). A frozen registry step wins over a later-projected raw index in either direction, so a tool update and an event can never mint two nodes for one child, and a child the tool channel already reported completed is neither re-cancelled nor relabeled aborted by the interrupt. A tool-result entry naming a child whose established owner is a DIFFERENT call is a conflict: the duplicate entry is dropped from the projection, tracked adoption is refused (the registry owner stands), the canonical outcome still reaches the owner's card, and reconciliation is requested over the same channel as ambiguous updates.

**Registry stickiness is attribution-independent** (round-4 follow-up): terminal stickiness lives in `registerObserved` itself, so it covers withheld children too — a parentless completion followed by stale running progress leaves the record `finished:true, live:false`, and the interrupt neither cancels nor re-renders it.

**Status**: landed 2026-10-23 (T010–T016). Rules 1–4 preserve every pinned single-call behavior verbatim (suite green, including the pre-existing late-completion, parentless-single-call, and mid-turn-attach pins); rule 5 (registry-aware withhold) replaced the shipped `activeTaskCall` fallback (last-started call wins), which under the 2026-10-23 six-way fan-out minted four phantom cards under one parent. Pinned by the US9 block in `test/subagent.test.js` and the fleet-interrupt scenario in `test/e2e.test.js`.

### 5.5 Upstream ask (FR18): consumer-side finalize sweep

The bridge closes the interrupt path (§5.1–§5.3), but one hole is consumer-owned and cannot be repaired bridge-side: **T3 Code finalizes a run without sweeping its open subagent rows.**

Evidence (extracted T3 0.1.2 Pi adapter, same extraction set as [../subagent-open-gap-report.md](../subagent-open-gap-report.md)):

1. `finalizeTurn` runs on `agent_settled` and marks the turn done **without closing open subagent rows** — rows whose last `subagent.updated` said `status: running` keep that status in the orchestration store forever (incident 2026-10-23, thread `5fd61a7a`: ten rows frozen `running`).
2. After finalization the adapter drops every further frame for the turn (`turn === null` gates both `tool_execution_update` and notify projection) — so terminal updates that arrive later can never heal the frozen rows.
3. T3's own Codex adapter is the reference behavior: it propagates a parent-run interrupt down to child turns and closes them; the Pi adapter has no equivalent sweep.

**Upstream change request (to T3 Code)**: `finalizeTurn` should close (or force-terminal) open subagent rows for the finalizing run, exactly as the Codex adapter propagates termination to child turns — covering *every* finalization path (interrupt, settle, error), not only the ones this bridge can pre-terminalize via §5.1.

**Not bridge-repairable**: rows the consumer already finalized before this bridge's sweep runs (or before this round's fix is installed) stay as they are. The bridge does not fake-repair them — no synthetic updates are sent for finalized turns (the adapter would drop them, §5.1 ordering is what makes the live window work), and no consumer-side state is written directly. The honest disposition is this ask plus the bridge-side guarantee that every window the bridge *can* reach is closed: interrupt (§5.1), ambiguous children (§5.3), withheld cancellation (§5.3/FR19).
