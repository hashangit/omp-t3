# 1.4.0-3

Content release: registry-only adoption of unseen calls, provenance-scoped post-abort cancellation window, delegation enforcement, and the full repair history of two gate cycles. Gatekeeper REVIEW: **PASS** at seal `0aae8c6` (R3 receipt: `Reviews/2026-10-24-1.4.0-3-gatekeeper-REVIEW-R3.md` — suite 166/166 at the seal, 173/173 with the enforcement additions, fleet 7/7, 0 P0/P1, 0 FALSE).

## Registry-only adoption of unseen calls

Task calls the bridge never saw start (mid-turn attach, missed start frames) are adopted for attribution, registry cancellation, and hold-open bookkeeping only — no synthetic status/end frames are emitted onto an id T3 may not hold a card for. This closes the phantom-card and foreign-card-closure defects from the previous iteration's open-call adoption. Adopted ids are tracked in a separate set and can never capture parentless frames via the sole-task-call fallback. **Recorded trade-off:** mid-turn-attached children no longer render live status lines — they remain tracked, counted toward hold-open notices, and are cancelled at interrupt.

## Provenance-scoped cancellation window

After an interrupt (`abort` or the combined `abort_and_prompt`), the sweep records every task-call id known at that moment; while the window is armed (until the next plain prompt), only children belonging to those pre-interrupt calls — or to calls adopted during the window itself — are cancelled on observation. The new turn's own spawns are never cancelled, fixing both the previous iteration's silent no-op on `abort_and_prompt` and an over-cancellation variant.

## Delegation enforcement

The native `task` tool is **removed from T3-mediated sessions**: the shim launches omp with `--tools=<built-ins minus task>` and appends a delegation policy to the system prompt routing subagent-shaped work to T3's `delegate_task` MCP tool (isolated, openable child threads with their own provider scope). Default on; `OMPT3_DELEGATE_TASKS=0` opts out; user-passed `--tools`/`--append-system-prompt` are preserved and merged. In-process subagents — the shared-heap crash class — stop existing in T3-mediated sessions.

## Hygiene

Unpredictable overlay `.tmp` names with cleanup on every failure path; `childIn` stream error listener so a late window-cancel can never kill the shim; `resolveCallId`/`adoptUnseenCall` doc blocks rewritten to the current trust rule; README historical entries reworded and correctly version-attributed; changelog sections for 1.4.0-2 and 1.4.0-3.

## Known residuals (gate-accepted, owner-surfaced, next-round candidates)

The two-repair limit was exhausted at this seal, so the following gate-confirmed residuals ship recorded (receipt R3, findings 1–3 + 4):

1. **P2-A:** while the post-abort window is armed, a task call whose start frame was never seen is adopted at attribution time and its children — including unambiguously post-abort work — receive real `cancel_subagent` kills. The in-code rationale is false and will be reworded or the arm redesigned (run-epoch provenance) next release.
2. **P2-B:** the disarm seam (plain prompt → `disarmAbort`) has zero suite coverage at the proxy layer; the e2e pin named for it cannot fail from a disarm outage.
3. **P2-C:** the adopted-straggler window-coverage arm ships unpinned (deletion survives the suite).
4. **P3:** three comment sites contradict the shipped behavior on the adopted-while-armed question; `adoptedCalls` unbounded growth lacks the in-code trade-off note.

Install note: npm dist-tags at gate time were `latest: 1.3.0-4` / `beta: 1.4.0` — publish with an explicit `--tag` decision; until npm publish lands, install from a checkout (`npm install -g .`) or run `bin/omp-t3` directly.
