# Implementation Tasks: Bridge Hardening & UX Parity Round (`omp-t3` Round 2 + incident rounds 3–4)

**Feature**: `002-bridge-ux-parity`
**Branch**: `feat/bridge-ux-parity`
**Status**: Complete — spec closed and merged to main (2026-10-23). Suite 153/153; live bridge/omp verification in quickstart §10.1–§10.2. Owed, recorded honestly: T3 adapter/UI/DB verification on the final tree, and the independent Gatekeeper review of the committed candidate. Upstream limits: FR18 finalized zombies, US1 clickable sessions.
**Created**: 2026-10-23 (speckit specify → plan → tasks pipeline; setup scripts absent from `.specify/`, paths resolved from `.specify/feature.json`)

Completed tasks carry a `verify:` line per the repo's Gatekeeper rule — every `[x]` claim must be reproducible at the seal.

---

## Task List

### Phase 1: Foundational — interrupt lifecycle (US10, round 3 — landed)

- [X] T001 [US10] Terminalize tracked subagents synchronously on interrupt, before any settle synthesis: `abortSweep()` in src/subagent.js wired through `SettlementTracker.onAbort` (src/settlement.js) into the abort branch of src/proxy.js — verify: `test/subagent.test.js` "abortSweep terminalizes unfinished children and returns cancel requests for both sides"; `test/e2e.test.js` "interrupt with live subagents terminalizes cards, then cancels omp children" and "idle interrupt (paused run) still sweeps subagents before the immediate settle"; full suite 127/127 green (2026-10-23).
- [X] T002 [US10] Cancel omp children on interrupt: one `cancel_subagent` (id namespace `ompt3-sub-`) per live child, written before the forwarded abort; responses consumed and suppressed — verify: e2e interrupt test asserts cancels `['c0','c1','c2']` precede the forwarded abort; `test/subagent.test.js` "cancel_subagent responses are consumed and suppressed".
- [X] T003 [US10] Reconcile against omp's authoritative child list: single-flight, ≥1s rate-limited `get_subagents` triggered on subscription response / new task call / hold-open tick; snapshots merge by child id and never un-finish — verify: `test/subagent.test.js` "get_subagents snapshot heals a missed spawn and is suppressed from T3" plus the unchanged-snapshot no-churn and weaker-evidence no-update assertions; e2e "task call opening triggers a get_subagents refresh".

### Phase 2: US1 — Clickable subagent sessions (gap-report path)

- [X] T004 [US1] Establish openability feasibility from the extracted Pi adapter and ship the honest outcome: no identity fields injected into `results[]`; gap report with evidence and the upstream ask in specs/002-bridge-ux-parity/subagent-open-gap-report.md — verify: report names `childThreadId`, the hardcoded `null`, and the ask; subagent rendering regression pins green in `test/subagent.test.js`.

### Phase 3: US2 — Hold-open notices

- [X] T005 [US2] Hold-open notices over the verified notify channel: `notifyFrame`/`holdOpenText`/`HoldOpenTracker` in src/notices.js, wired to withheld-settlement detection in src/settlement.js and src/proxy.js — verify: `test/notices.test.js` (frame shape, honest counts, once-per-hold-interval, signature-change re-emit); `test/parity.test.js` end-to-end hold-open scenarios (subagent count + background fallback).

### Phase 4: US3 — Drift visibility

- [X] T006 [US3] Drift notices in-thread immediately before the synthesized settle, sharing the doctor's 24h per-signature ledger — verify: `test/doctor.test.js` (notify-before-settle ordering, ledger coupling, discovery failures stay off-thread).

### Phase 5: US4 — Live subagent narration

- [X] T007 [US4] Narration precedence on subagent cards (running: child's own step words; finished: final assistant text; `recentOutput` fallback; absent → byte-identical emission) in src/subagent.js — verify: `test/subagent.test.js` narration tests ("lastIntent wins over recentOutput while the child is running", finished-text takeover, progress-item projection only-when-absent).

### Phase 6: US6 — First-launch discovery

- [X] T008 [US6] Raise the cold-start command-discovery bound 2500ms → 10000ms inside the consumer's 30s window; single-flight behavior unchanged in src/commands.js — verify: `src/commands.js` `refreshTimeoutMs ?? 10_000`; CommandBridge tests green; suite 127/127.

### Phase 7: US8 — Self-update parity

- [X] T009 [US8] `update` action in src/cli.js + src/updater.js: no-op default with channel + manual-command guidance (exit 0), real package-manager update only behind `--yes`, git checkout always guidance-only; `--check` self-update line — verify: `test/cli.test.js` update routing ("parseArgs routes update (T3 provider maintenance form) to a no-op intent", "--yes" gating); `test/updater.test.js` "US8: default update [--self] is a successful no-op with manual guidance".

### Phase 8: US9 — Attribution under parallel fan-out (round 4, review-hardened — landed)

**Follow-up fixes (2026-10-23, external review of the first round-4 cut + final check)** — verify: test/subagent.test.js "FR15: tool-result child at index 5 keeps its step when an event later claims index 0", "FR15: event-attached child keeps its step when a tool result claims another index", "FR19: a child observed only through task tool results is registry-tracked and swept", "FR17: a snapshot re-attaching a finished child restores its terminal state", "FR17: a snapshot after the sweep restores the swept terminal state", "FR16/FR17: a child completed via tool updates is not re-cancelled or re-aborted", "FR15/FR17: a stale running tool update never un-finishes a completed child", "FR19: terminal stickiness holds for unattributed children (parentless completion then stale progress)", "FR15: a conflicting explicit parent withholds and reconciles instead of duplicating", "FR15: a conflicting tool-result entry is dropped, adopted nowhere, and reconciled", "FR17: a conflicting-parent completion terminalizes the recorded owner card (event path)", "FR17: a conflicting-parent completion in a snapshot terminalizes the owner card", "FR17: a conflicting tool-channel completion terminalizes the owner card", "FR17: conflicting failed status carries the error outcome to the owner card", "FR17: a completed tool record after a failed child preserves the error outcome", "FR17: a completed tool record after an aborted child preserves interrupted", "FR17: an aborted tool record after a completed child does not relabel it"; test/e2e.test.js "E2E: conflicting-parent completion terminalizes the owner card before the settle" (the final-check report's proxy reproduction); suite 153/153; 600-sequence mixed-channel invariant matrix — zero violations; live re-runs after the fixes: 0 phantoms / 0 renumbering / 0 children in >1 parent map / sweep terminal updates before the settle / 6/6 `cancelled:true` / 0 running rows post-settle, and natural-drain + late interrupt with completions only via the tool channel → 0 cancels, honest completed cards.
1. Task-tool results (`normalizeTaskRecords` → `registerFromToolResult`) route through the registry and the §5.4 step rule: a child first projected at a tool-result index keeps that frozen step against later events/snapshots (no duplicate card), and a tool-result-only child is sweep-cancellable and card-terminalizing.
2. Terminal outcomes persist in the registry (`finished`/`stopReason`/`exitCode`) across per-call map pruning: a running snapshot or post-sweep reconciliation re-attaches a finished/swept child in its terminal state instead of resurrecting it as running.
3. Tool observations are ALWAYS merged into the tracked child (frozen step or not), terminal-stickily, and the merged state is projected into the outgoing frame: a tool-completed child is not re-cancelled/re-aborted by the interrupt, and a stale running tool update after a completion event emits a terminal card and keeps registry `live:false`.
4. Terminal stickiness lives in `registerObserved` and is attribution-independent: a parentless completion followed by stale running progress leaves the withheld record `finished:true, live:false`; the interrupt neither cancels nor re-renders it.
5. Ownership is not renegotiable (`resolveCallId`): a known explicit parent contradicting the recorded owner withholds the update and requests reconciliation (events/snapshots); a conflicting tool-result entry is dropped from the projection, adopted nowhere, and reconciled — one child keeps exactly one parent card.
6. Conflicting-parent TERMINAL observations project the canonical outcome onto the recorded owner's card on every channel (events, snapshots, tool results/progress — `projectTerminalToOwner`): the conflicting frame still renders nothing under the wrong parent, and the owner's card can no longer zombie into the settle (final check, finding 1, High).
7. The terminal outcome is first-terminal-wins and projected unconditionally once terminal: a completed tool record after a failed/aborted child preserves `stopReason`/`exitCode` in the outgoing card, and a contradicting flavor is stripped (final check, finding 2, Medium).

- [X] T010 [US9] Track the open-task-call set (tool-execution start adds, end removes) and the live-child registry — `childId → { ownerCallId, step, live, status }` — in src/subagent.js; register every observed child at first sighting, attributed or not (contracts/frame-contract.md §5.3) — verify: `bridge.openCalls`/`bridge.childRegistry` in src/subagent.js; exercised by every US9 test in test/subagent.test.js (withheld child observed as `{ ownerCallId: null, step: undefined, live: true, status: 'running' }` in "FR14/FR19: late orphan...").
- [X] T011 [US9] Replace the last-started-call fallback in `resolveCallId` (src/subagent.js) with the §5.3 ordered rule — explicit known parent → already-attributed child's recorded owner → only task call ever seen → explicit parent when no history → ambiguous — applied identically to event frames and `mergeSnapshots`; an open call alone never attaches an unknown child once more than one task call has been seen — verify: test/subagent.test.js "FR14: six concurrent task calls...", "FR14: parentless follow-up from an attributed child follows its recorded owner", "FR14: mid-turn attach...", plus the unchanged pre-existing single-call pins; `activeTaskCall` no longer exists in src/subagent.js.
- [X] T012 [US9] Ambiguous disposition: withhold emission (no card minted), keep the child registered with `ownerCallId: null` plus its observed status, and request reconciliation via the rate-limited `refreshRequest()` — verify: test/subagent.test.js "FR14: six concurrent task calls..." (withheld.line undefined, refreshRequested true, registry entry null-owner live); proxy.js forwards `refreshRequested` to `requestSubagentRefresh()`; rate limit pinned by the pre-existing "single-flight while a refresh is pending" assertions.
- [X] T013 [US9] `abortSweep()` (src/subagent.js): cancel every live registry entry by id (FR19) — attributed children keep the existing terminal-update + cancel path; withheld children contribute `cancel_subagent` only; swept entries flip to not-live so a second sweep stays a no-op — verify: test/subagent.test.js "FR14/FR19: late orphan..." (toClient empty, cancel for the withheld child, second sweep `{toClient:[],toOmp:[]}`); pre-existing "abortSweep terminalizes..." and "snapshot never un-finishes..." pins unchanged; e2e "interrupt with live subagents..." unchanged.
- [X] T014 [US9] Stable projected step (§5.4): assign once at first attributed attach — the child's own index when unique among the parent's current children, else the next free integer — frozen for the child's lifetime; covers duplicate indices, missing indices, and event/snapshot disagreement — verify: test/subagent.test.js "FR15: duplicate fleet indices and missing indices get distinct stable steps", "FR15: snapshot index disagreement never renumbers an attached child" (step stays 0 under a snapshot claiming index 5); pre-existing step-ordering pins unchanged.
- [X] T015 [US9] Regression tests in test/subagent.test.js: six concurrent task calls + parentless frames → no phantoms, correct parents; late orphan (call A ends, call B starts, A's unknown child reports parentless) → no card, child registered live, cancelled by sweep; known-child parentless follow-up → recorded owner; step stability under duplicate index and snapshot disagreement; pinned single-call behaviors unchanged (late completion during a later tool call; parentless single-run frame; mid-turn attach) — verify: the six FR14/FR15 tests under "--- Feature 002 US9/FR14/FR15/FR19 ---" (test/subagent.test.js) plus the unchanged pre-existing pins ("subagent frames during later tools re-parent...", "SubagentBridge orders entries by step and suppresses unattachable frames"); file passes 29/29.
- [X] T016 [US9] E2E test in test/e2e.test.js: parallel fleet + mid-run interrupt → exactly the real children rendered, zero cards running after settle, every dispatched child cancelled including withheld ones — verify: "E2E: parallel fleet + mid-run interrupt renders exactly the real children and cancels the withheld ones" (card parents exactly c1–c5, rendered set size 5 with no ghost, per-call terminal updates stopReason aborted, cancels = ghost+s1..s5 all before the forwarded abort, single aborted settle, zero finished:false after the settle).

### Phase 9: US10 — Upstream ask & live verification (landed)

- [X] T017 [US10] Document the consumer-side finalize-without-sweep upstream ask (finalizeTurn should close open subagent rows when a run finalizes) with extracted adapter evidence, and state that already-finalized zombie rows are not bridge-repairable — extend specs/002-bridge-ux-parity/contracts/frame-contract.md §5 or subagent-open-gap-report.md — verify: contracts/frame-contract.md §5.5 "Upstream ask (FR18): consumer-side finalize sweep" (three evidence items from the T3 0.1.2 Pi adapter extraction, the finalizeTurn change request, and the explicit not-bridge-repairable disposition).
- [X] T018 [US10] Live-verify the incident scenario in T3 (six-call fleet + mid-run interrupt): zero phantom cards, zero running rows post-settle, children actually stop — record per quickstart.md §10, including the late-orphan probe (§10 item 6) — verify: quickstart.md §10.1 (three live runs 2026-10-23 against omp 18.12.6 from this checkout, both wire sides captured: run 1 = 561/1001 frames parentless with 0 phantoms; run 2 = detached-children interrupt, sweep-fault found and fixed with regression pin; run 3 = all 6 terminal updates before the settle, 6/6 cancels `data.cancelled:true`, 0 running rows post-settle).

### Phase 10: Polish & cross-cutting

- [X] T019 FR1/FR10/FR11/FR12 pins present and green — verify: `test/cli.test.js` "FR1 pin: --session and --fork launch arguments forward byte-identically"; `test/parity.test.js` "FR11 pin: fork/switch_session upstream and get_entries responses cross byte-identically"; `test/settlement.test.js` auto-compaction pair pins; `src/extension_compat.js` `readDeferralLedger` + `test/extension_compat_ledger.test.js`.
- [X] T020 Spec/plan/research/data-model/contracts/quickstart amended for rounds 3–4 including the round-4 review fixes (this pipeline run) — verify: spec.md US9/US10 + FR14–FR19 + SC10 + History (incl. review entry); frame-contract.md §5.3–§5.4; research.md R6/R7; data-model.md registry/attribution section; quickstart.md §10 (incl. late-orphan probe); plan.md R6/R7 + round-3/4 corrections (incl. item 11) + risks.
- [X] T021 After T010–T016 land: full suite green (baseline 127), quickstart §0 count updated, SC10 demonstrated including the late-orphan and cancel-when-unattributed cases (FR13/FR15 pins for every new shape) — verify: `npm test` 153/153 green (2026-10-23, post round-4 + the seven review-gap fixes; 127 baseline + 26 new pins); quickstart.md §0 count = 153; SC10 demonstrated in quickstart.md §10.1–§10.2 (live runs + post-fix rerun + 600-sequence mixed-channel invariant matrix) — late-orphan shape pinned in test/subagent.test.js, cancel-when-unattributed pinned by "FR14/FR19: late orphan…", "FR19: a child observed only through task tool results…", and "FR19: terminal stickiness holds for unattributed children…", live cancels covering registry children. Scope: bridge-pipeline verification; T3 UI/DB verification owed (§10.2 scope note).

---

## Dependencies & Completion Order

```text
Phases 2–7 (US1–US8)          landed, independently verified
   │
   ▼
Phase 1 (US10 round 3)        landed (abort sweep, cancellation, reconciliation)
   │
   ▼
Phase 8 (US9 round 4)         T010 → T011 → T012 → T013 → T014 → T015 → T016   (sequential: one module)
   │
   ├────────────────────────────┐
   ▼                            ▼
Phase 9 (US10 asks/verify)   Phase 10 (T021 final suite)
```

- Phases 2–7 are complete and mutually independent; nothing in Phase 8 depends on re-touching them.
- Phase 8 is strictly sequential (one module, layered: state → rule → disposition → sweep → step → tests).
- T017 is documentation-only and parallelizable with Phase 8; T018 requires Phase 8 landed.

## Parallel execution examples

- T017 (docs) can run alongside T010–T014 (code).
- T015 and T016 touch different test files but depend on T011–T014; write them back-to-back after the code lands.

## Implementation strategy / MVP scope

**MVP = Phase 8 (US9).** It is the only remaining code gap (the incident's phantom-row fault, now covering the late-orphan and hidden-child-cancellation shapes from review); everything else is landed and pinned. T010–T016 + T021 close the feature. T017/T018 are the honest-outcome documentation and live verification for US10.
