# Quickstart: Validating the Round End-to-End

Prerequisites: T3 Code 0.1.2+, omp ≥ 18.12.6, bridge installed (`node bin/omp-t3` or global), `npm test` green before starting. Each scenario maps to a spec success criterion. (Scope of scenarios matches the reviewed round: approval-cache and session-translation scenarios were cut.)

## 0. Regression baseline

```bash
npm test                      # 118 tests, all green (FR13; baseline was 82)
node bin/omp-t3 --check       # all PASS, plus new Self-update channel + Extension deferral lines
```

## 1. Click-to-open subagent sessions (SC1 → gap-report path)

Expected outcome: no behavior change in the bridge; the gap report exists with extracted evidence.
1. Run any turn that spawns subagents; open a subagent entry — no open button renders (as today; renderer gates on `childThreadId !== null`).
2. Confirm `specs/002-bridge-ux-parity/subagent-open-gap-report.md` names the mechanism (`childThreadId`), the hardcoded null, and the upstream ask.
3. Regression guard: subagent progress/result rendering unchanged (`test/subagent.test.js`).

## 2. Hold-open notice (SC2)

1. Start a turn whose subagent/background work outlives the answer (e.g. subagent running a dev server; or a plain background `sleep 90 &`).
2. Within ~2s of the answer finishing, the T3 thread shows a system notice — `Run held open: <N> pending subagent(s)` when the bridge can count live children, else `Run held open: pending background work` (omp exposes work pending only as a boolean; the notice never invents counts).
3. Let the work drain (or stop it) → run settles normally; no duplicate notices while the pending signature is unchanged; a count change produces exactly one updated notice.
4. With no pending work, turns behave byte-identically to 1.3.0-5 (no notices). Pinned: `test/notices.test.js`, `test/settlement.test.js`, `test/parity.test.js`.

## 3. Drift visibility (SC3)

1. Simulate withheld settlement (test harness or drift injection per `test/doctor.test.js` patterns).
2. Watchdog fires → the notice is written in-thread BEFORE the synthesized settle (turn still active → consumer renders it); `~/.local/state/omp-t3/contract-state.json` still records the issue at most once per signature per 24h and a repeat within the window re-logs stderr but does not re-notice. Discovery failures (no active turn exists) never notice in-thread. Pinned: `test/doctor.test.js`.

## 4. Subagent narration (SC4)

1. Run a multi-step subagent task; watch its task card.
2. Step text changes mid-run in the subagent's own words (omp ≥ 18.12.3 `lastIntent`); on finish the final assistant text takes over; `recentOutput` remains the fallback; entries without narration emit byte-identically to before.
3. Pinned by the narration tests in `test/subagent.test.js`.

## 5. (cut) Approval cache

Cut in review — no bridge surface. Approval dialogs keep the feature-001 passthrough; the upstream ask lives in [research.md](./research.md) R3.

## 6. First-launch discovery (SC6)

1. Clear warm state (`rm -rf ~/.cache/omp-t3` / command catalog cache) 5×.
2. Each cold start: model list + command menus populated on first poll; no empty-first-poll; workspace slash menu shows omp commands/skills on first open.
3. Stall guard: with omp artificially slow (>10s), the bridge still answers (bounded by the raised 10s wait) and T3's snapshot never hangs. Default changed 2500ms → 10000ms (`src/commands.js`); pinned by the CommandBridge tests.

## 7. (cut) Session continuity

Cut in review — omp parses `--session`/`--fork` natively (live-verified against 18.12.6), and the bridge forwards them unchanged. Only pins remain: FR1 in `test/cli.test.js` (launch argv passthrough) and `test/parity.test.js` (in-stream `switch_session`/`fork`/`get_entries` passthrough).

## 8. Self-update (SC8)

1. `node bin/omp-t3 update --self` (what T3's provider maintenance runs): exits 0, prints the detected install channel, real install path, and the exact manual command — nothing is mutated.
2. Opt-in real update: `node bin/omp-t3 update --yes` on an npm-global install → runs `npm update -g omp-t3` and propagates its exit code; on a Homebrew install → `brew upgrade hashangit/omp-t3/omp-t3`; on this checkout install → still guidance-only.
3. `node bin/omp-t3 --check` reports `Self-update channel: <channel> (<path>) — update with: <command>`.
4. Never observed: `Unknown option '--self'`/`Unknown option 'update'`. Pinned: `test/cli.test.js`, `test/updater.test.js`.

## 9. Upstream behavioral pins (FR10–FR12, SC9)

1. FR10: post-settle `auto_compaction_*` synthetic frames → pair still translates, no second `agent_settled`, run not reopened, next prompt still settles (`test/settlement.test.js` FR10 pin).
2. FR11: rollback/fork across a compacted session → `switch_session`/`fork` frames and `get_entries` responses cross the pipeline byte-identically (`test/parity.test.js`), plus one manual rollback in T3 against a real compacted session.
3. FR12: two consecutive launches with an unchanged compat copy → `agent.db` cache row `extension_startup:v1:<compat path>` exists with `{"fingerprint":"<size>:<mtimeMs>","deferrable":true}`; then `node bin/omp-t3 --check` prints `[PASS] Extension deferral: deferred startup active (fingerprint matches current compat copy)`. Live proof on launch 2: a first-turn tool invocation and a `$name` skill mention both work while the extension loaded deferred (no eager first-message delay). Implementation note: `src/extension_compat.js` `readDeferralLedger()` (best-effort `node:sqlite` probe; graceful WARN when the db or module is unavailable).
