# 1.4.0-2

Gate-repair release for the findings recorded in `Reviews/2026-10-24-fix-gate-findings-and-abort-window-gatekeeper-REVIEW-R2.md` (Gatekeeper REVIEW: **PASS** at seal `6a84355` — suite 162/162, fleet 7/7, 0 P0/P1, 0 FALSE task-truth rows).

## Unseen-parent adoption fix (prior gate MEDIUM)

A second mid-turn task call whose start frame the bridge never saw no longer hijacks its children into the first adopted call. The bridge now records every started **non-task** tool (wait/bash) and trusts a child's explicit parent unless it points at one of those — genuinely unseen task calls are adopted as open calls, so their children render under their own cards and the interrupt sweep closes them. Pins: two-unseen-calls, late parentless follow-up, distrusted wait parent.

## Notification-bar stop hardening (post-abort cancellation window)

Stopping a run arms a **cancellation window**: any subagent child that surfaces *after* the interrupt sweep (an in-flight spawn finishing, a late snapshot before the settle) is cancelled the moment the bridge observes it, instead of running to completion with nobody holding its id. A new turn's prompt disarms the window so next-turn children spawn freely.

Known edge (recorded in the gate receipt, next-round candidate): the window does not arm for combined `abort_and_prompt` interrupts — the arm and disarm land in the same handler. The follow-up is a run-epoch counter, and the per-row stop affordance itself remains a T3 upstream ask (no per-child cancel frame exists on the Pi wire).

## Docs & hygiene

- README cap bullet names the per-value overlay file (`subagent-limits-<N>.yml`).
- Changelog: pre-1.4.0 card-era entries moved under a `### 1.4.0` header; "unchanged" reworded to "retained".
- `Number.isSafeInteger` guard on the cap value (no overflow filenames); `.tmp` file removed if the overlay rename fails; stale comments reworded.

## Known defects shipped in this release (confirmed by the gate, next-round candidates)

This release knowingly ships with three probe-confirmed P2s — all edge configurations of this round's own headline "Unseen-parent adoption fix" and cancellation window. Each is verified first-hand in the gate receipt; none affects normal operation, and all are top candidates for the next repair round:

- **P2-1:** a live task card whose call was adopted *after* the interrupt sweep ran (unseen-parent adoption on an already-cancelled child) re-opens a narrow zombie/phantom-card window — no synthetic end is emitted for it on that abort.
- **P2-2:** an unseen **active non-task** tool (a bash/wait start missed by the bridge) can be adopted as a task call, landing synthetic `task` frames and a sweep `tool_execution_end` on T3's real foreign card.
- **P2-3:** the post-abort cancellation window is a no-op for combined `abort_and_prompt` interrupts — the arm and disarm land in the same synchronous handler (probe-confirmed `abortArmed:false`, zero cancels). The designed follow-up is a run-epoch counter; the per-row stop affordance itself remains a T3 upstream ask (no per-child cancel frame exists on the Pi wire).

## Verification

Suite 162/162. Gatekeeper REVIEW PASS at `6a84355` with these 3 probe-confirmed P2s (each verified by two independent parties plus the gate keeper) and 14 P3/INFO — all recorded in the receipt, none blocking.
