# Implementation Plan: Bridge Hardening & UX Parity Round (`omp-t3` Round 2)

**Branch**: `feat/bridge-ux-parity` (cut fresh from `main` — the previous feature branch was already merged; the old plan's "current branch retained" line is superseded)
**Spec**: [spec.md](./spec.md) · **Research**: [research.md](./research.md) · **Data model**: [data-model.md](./data-model.md) · **Contracts**: [contracts/](./contracts/) · **Quickstart**: [quickstart.md](./quickstart.md)

## Technical Context

| Aspect | Value |
|---|---|
| Project | `omp-t3` — stdio translator bridge: T3 Code ↔ Pi-compatible shim ↔ omp |
| Language/Runtime | Node.js (CommonJS), zero runtime deps, `node:test` suite (baseline 82 tests) |
| Distribution | npm + Homebrew (`hashangit/omp-t3` tap), version `<pi-major>.<pi-minor>.<pi-patch>-<iter>` (this round: `1.3.0-6`; Formula bumped at release, not before) |
| Baseline (audited 2026-10-23) | T3 Code 0.1.2 (provider-pi embedded in `t3` ELF), omp 18.12.6, contract audit: zero frame-shape breaks |
| Key upstream changes consumed | T3: 30s discovery window, `extension_ui_request`/`notify` → `system_notice` rendering (turn-gated), `update --self` resolver call. omp 18.12.3–18.12.6: subagent step narration (`lastIntent`), deferred extension loading, native `--session`/`--fork`, `get_state.hasPendingAsyncWork` |
| Source layout | `src/cli.js` (argv translation + `update` action) · `src/proxy.js` (frame pipeline, notice wiring) · `src/settlement.js` (settle mirroring + hold detection) · `src/notices.js` (notify frames + HoldOpenTracker) · `src/subagent.js` (subagent bridge + `pendingCount()`) · `src/commands.js` (command catalog) · `src/model_catalog.js` (catalog prune/cache) · `src/doctor.js` (drift watchdog + `onNotice`) · `src/updater.js` (self-update) · `src/extension_compat.js` (T3 extension adapter + deferral-ledger reader) · `bin/omp-t3` (entry) |
| Tests | `test/*.test.js` — synthetic frames + fake child streams; e2e spawns the shim binary |

## Constitution Check

No `.specify/memory/constitution.md` present → no project constitution gates. Governing principles applied from feature 001 (Zero-Fork Principle, §7.2 "a frame shape without a test is a drift regression waiting to happen") are honored by design: FR4–FR6 notices and narration are additive signaling; every new projected shape ships with a pinning test (FR13). **Post-design re-check**: after contracts/ are written — see bottom of this file.

## Phase 0 — Research (open unknowns)

| # | Unknown | Driven by | Status |
|---|---|---|---|
| R1 | Can T3's Pi surface open child subagent sessions at all — and what identifier does it need? | US1/FR9 | **RESOLVED: UNSUPPORTED bridge-side** → gap-report path; artifact: [subagent-open-gap-report.md](./subagent-open-gap-report.md) |
| R2 | Exact `update --self` invocation contract from T3's driver; correct self-update behavior per install channel | US8/FR2 | **RESOLVED**: argv `<binaryPath> update --self`, cwd = workspace, exit/output/timeout captured, failure = WARN only. **Review correction**: default is no-op + guidance for every channel; real updates opt-in via `--yes` (global package mutation must be user-initiated) |
| R3 | omp approval-mode surface (flag/env/config key, extension_ui coverage) | US5/FR7 | **RESOLVED then CUT in review**: T3's visible gating is its extension hook and no in-thread approval suppression path exists, so caching via the bridge adds prompts without benefit; cut to upstream ask (R3's evidence retained) |
| R4 | T3 discovery init sequence vs bridge's 2.5s cold fallback; is the fallback user-visible? | US6/FR8 | **RESOLVED**: fallback never an error/stall (workspace snapshot blocks on the answer); raise bound 2500ms → 10 000ms |
| R5 | Does `--mode rpc-ui` defer the T3 MCP extension; first-message impact; force eager or accept deferred? | FR12 | **RESOLVED**: deferred is safe (deferral ledger in `agent.db`; tools register before first turn) → accept deferred; verification = `--check` ledger probe + quickstart two-launch scenario (not a live-omp unit test) |

Consolidated decisions: [research.md](./research.md)

## Phase 1 — Design artifacts

- [data-model.md](./data-model.md): HoldOpenNotice, DriftNotice, SubagentEntry extension; TranslatorState additions
- [contracts/](./contracts/): notice frame contract (FR4/FR5), self-update CLI contract (FR2), passthrough launch contract (FR1), subagent entry contract (FR6)
- [quickstart.md](./quickstart.md): end-to-end validation scenarios mapping to the SCs

## Review corrections (2026-10-23, /scrutinize — approved for implementation)

1. **Notice channel corrected**: T3 0.1.2's adapter has NO `tool_execution` handler; the old `tool_execution`/`notify` tool-call frame would have rendered a fake tool card. Landed channel: `extension_ui_request` `method:"notify"` (omp's own notify shape), projected to `system_notice` only while a turn is active. Drift notices are therefore wired to the settle-watchdog path and written immediately BEFORE the synthesized `agent_settled` (same ledger, `report(..., {notify:true})`).
2. **US3 narrowed**: discovery failures stay off-thread (they precede any turn — the consumer drops those notices anyway); in-thread notices cover the watchdog's settlement synthesis only.
3. **US5 cut** (approval cache): net-negative — no suppression path; upstream ask retained.
4. **US7 cut** (session translation): omp parses `--session`/`--fork` natively (live-verified); FR1 is a byte-passthrough pin; help text already truthful — no removal.
5. **FR4 honesty**: omp exposes no pending-work counts/kinds; hold text states the subagent count only when `subagentBridge.pendingCount() > 0`, else "pending background work".
6. **FR2 shape**: no-op default + `--yes` opt-in (T3 calls `update --self` routinely; WARN-only on failure).
7. **FR12 placement**: verification lives in `--check` (deferral-ledger read via `node:sqlite`) + quickstart scenarios.
8. **Branch/version**: branch from `main`; version `1.3.0-6`; two commits (docs corrections, then implementation).

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| ~~R1 verdict = UNSUPPORTED~~ **MATERIALIZED** | Occurred | FR9's honest fallback shipped as the [gap report](./subagent-open-gap-report.md) + upstream ask; no fake UX |
| In-thread notices (FR4/FR5) spam the thread during churn | Medium | Rate-limit ledger shared with doctor issue filing; one notice per hold interval; re-emit only on pending-signature change; hold state cleared on settle |
| ~~Approval cache surprises users~~ **CUT** | Occurred at design time | Feature dropped with rationale recorded in spec/contracts; upstream ask filed |
| `update --self` mis-detects install channel and updates the wrong install | Low | Realpath-based channel detection (npm root / Homebrew prefix / checkout); real update only behind `--yes`; ambiguity → explicit no-op success with guidance |
| ~~Deferred extension loading delays MCP tools~~ **CLOSED by R5** | Closed | Accept deferred; `--check` ledger probe + quickstart verification |
| Notice frame shape mismatches T3 0.1.2 rendering | Closed | Final shape verified against extracted adapter source (notify branch, `turn !== null` gate) and pinned by tests |
| omp 18.12.x behavioral pins (FR10–FR12) flake in CI-like runs | Low | Pins use synthetic frames where possible (`test/settlement.test.js`, `test/parity.test.js`); live-binary checks isolated in `--check`/quickstart |

## Post-design Constitution re-check

**PASS** — all projected shapes additive (notices, richer text), every shape pinned at ship time (FR13), no fork of upstream semantics: the rejected look-alike notice frame, the approval cache, and session translation were all declined per the Zero-Fork Principle; nothing is sent upstream to omp, and the self-update no-op never mutates user installs.
