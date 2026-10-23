# v1.4.0

Bridge hardening for T3 Code ↔ Oh My Pi: incident-driven subagent correctness under
parallel task fan-out, terminal lifecycle closure on interrupt, and canonical
terminal-state handling across every observation channel.

**Compatibility**: T3 Code 0.1.2+, Oh My Pi (omp) ≥ 18.12.6 — verified live against
**omp 18.12.6** (the current pi release). This is the first plain-semver release;
the `1.3.0-N` prerelease scheme ends here.

## Subagent attribution under parallel fan-out (US9)

A single turn dispatching several concurrent task calls no longer produces phantom
cards. Child frames resolve their owning task call by an ordered rule — explicit
known parent, recorded owner, the only call ever seen, mid-turn attach — and an
unresolvable update is withheld from rendering (never misrendered) while
reconciliation against omp's authoritative snapshot attributes it. One child keeps
one parent and one stable projected step for its whole lifetime; duplicate or
missing fleet indices and event/snapshot disagreement can never mint a second card.

## Interrupt closure (US10)

Interrupting a run with live subagents terminalizes every card before the run
finalizes and cancels every observed live child — attributed, withheld, or hidden —
before the interrupt is forwarded, so detached children actually stop instead of
running on invisibly. Runs without tracked children are wire-identical to before.

## Canonical terminal state across channels

Lifecycle events, progress frames, task-tool results, and snapshots all feed one
child registry whose outcome is authoritative and first-terminal-wins: a completed
child is never resurrected as running, a stale record never erases a
failed/interrupted outcome, and a conflicting-parent completion terminalizes the
real owner's card instead of leaving a zombie into the settle.

## Also in this release

- Subagent stop and live-details translation across omp and T3 (18.12.x frames).
- Task-tool results feed the same registry, step assignment, and cancellation
  sweep as events and snapshots.
- Release engineering: tag-triggered GitHub Release workflow (`vX.Y.Z`, plain
  semver), gate receipts under `Reviews/`.

## Verification

- 153/153 tests (26 new pins over the previous seal), `node --check` + pack clean.
- 600-sequence mixed-channel invariant matrix: no duplicate-parent rendering, no
  terminal resurrection, no outcome erasure, no cancelling of finished children.
- Live wire runs against omp 18.12.6: six-call fan-out with zero phantom cards,
  interrupt terminalizes every card before the settle, every dispatched child
  confirmed cancelled (`cancelled:true`), zero running rows post-settle.

## Known limits (upstream, documented)

- Rows T3 already finalized before this fix stay as they are — the consumer-side
  finalize sweep is the upstream ask (FR18).
- Clicking a subagent entry opens nothing over this bridge — the Pi adapter
  hardcodes `childThreadId: null`; gap report and upstream ask documented (US1).
