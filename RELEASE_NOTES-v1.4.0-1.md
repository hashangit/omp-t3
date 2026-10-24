# 1.4.0-1

Iteration release after the 1.4.0 base drop (npm already holds plain `1.4.0`; the `<base>-<N>` scheme resumes per the owner decision recorded in AGENTS.md). Gatekeeper REVIEW: **PASS** at seal `dbbed2f` — suite 157/157, 7/7 reviewers, 0 P0/P1 (receipt: `Reviews/2026-10-24-feat-subagent-concurrency-cap-gatekeeper-REVIEW-R1.md`).

## Subagent concurrency cap (`OMPT3_MAX_SUBAGENTS`)

omp subagents are in-process tasks sharing omp's single V8 heap; long fan-out fleets can exhaust it and `SIGABRT` the whole provider scope. Setting `OMPT3_MAX_SUBAGENTS=<N>` in the shim's environment appends a `--config` overlay setting omp's native `task.maxConcurrency` — omp queues the N+1-th concurrent `task` spawn *and* tells the lead agent the limit in its own system prompt ("Max N concurrent subagents; excess queue."), so both enforcement and model communication are omp-native. Strict plain-decimal parsing, one immutable overlay file per distinct cap (atomic temp+rename; concurrent shims never fight), warn-and-continue on unwritable cache dirs. Recommended: 5 — native subagents are short parallel workers. Per-session scope: direct `omp` terminals keep their own setting.

## Quick tasks render as tool cards, not fake agents

omp's `task` subagents no longer masquerade as T3 subagent cards. The `task`→`subagent` rename and `details.results[]` synthesis are gone (task frames pass through byte-identical); each `task` call instead streams a compact live status line inside its own tool card — `3/6 done · running: Piranha (glm-5.3): reading src/auth` — built from `subagent_*` events and `get_subagents` snapshots. The interrupt sweep closes every open task card with one synthetic `tool_execution_end` and hard-cancels every live child via `cancel_subagent`; ended calls keep registry/cancellation semantics only. The phantom-row and zombie-row bug classes (rooted in T3's per-child subagent node keys) are structurally impossible for a generic tool card. Long-running delegated work now has a designated home: AGENTS.md §Subagents directs it to T3's `delegate_task` (openable child threads outside omp's heap).

## Hardening (gate repair round 1)

- Interrupt sweep closes **every** open task card, including the task-start→first-child window that previously hung a card `running` through the settle.
- Unwritable cache dir no longer crashes the shim: warn + launch uncapped.
- Lost `get_subagents` responses no longer pin reconciliation: a 10s stale window recovers the single-flight flag.
- Status emissions are gated on open calls — no `tool_execution_update` after a call's `tool_execution_end`.
- ~90 lines of post-pivot dead machinery removed (`exitCode` plumbing with no reader, write-only mandate tracking, registry-wide step collision scan).
- Mid-turn attaches adopt their unseen call so status lines render and the sweep closes them.

## Known non-blocking findings (recorded in the gate receipt, targeted next iteration)

A child explicitly parented to an unseen *second* task call (requires the bridge to miss ≥2 tool starts) misattributes to the first adopted call; the README cap bullet still names the pre-repair overlay filename; changelog "unchanged" wording overstates the repair round. Full list in the receipt.
