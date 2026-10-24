# Gatekeeper REVIEW — fix/gate-findings-and-abort-window (round 2 for seal 6a84355; round 1 died on a provider 429 before producing findings — nothing inherited, run fresh)

```
Mode: REVIEW
Scope: repair round on 1.4.0-1 (no work order — direct owner request; stated claims graded per gate brief) | Base: 03bb5cc (origin/main)
Branch: fix/gate-findings-and-abort-window | Seal: 6a84355 | Gates: suite 162/162 (npm test, 0 fail 0 skip; re-run by reviewer 2), probes N/A, examples N/A, build N/A, CI N/A (none configured)
Fleet: Red Team, Code Reviewer, Security Reviewer, Scrutinizer, Repo Auditor, Ponytail Reviewer, Architect (all 7 enabled, full fleet — code-bearing change on the provider bridge; Architect joined in Phase 4 per workflow)
Task truth: 4 TRUE / 0 PARTIAL / 0 FALSE
Findings: P0:0 P1:0 P2:3 confirmed / 0 refuted  P3:14 (confirmed Info/Low)
Verdict: PASS
```

## Phase 0 — deterministic checks
- Candidate tree clean at HEAD `6a843551e417909d2ef79fe2198b1c2757b99339`; only pre-existing untracked `.commandcode/` (ignored, untouched).
- `npm test` → `# tests 162 / # pass 162 / # fail 0 / # cancelled 0 / # skipped 0` (947 ms). Reviewer 2 independently re-ran: identical.

## Phase 1 — seal
Seal frozen: `6a84355`, branch `fix/gate-findings-and-abort-window`, base `03bb5cc`. Diff range `git diff 03bb5cc..6a84355`: 5 files — `src/subagent.js` (+86/−18), `src/cli.js` (+9/−2), `src/proxy.js` (+15), `README.md` (+6/−2... see stat: 6/6 lines churned), `test/subagent.test.js` (+74). HEAD did not move during the gate.

## Phase 2 — task truth (stated claims, no work order)
| # | Claim | Grade | Evidence |
|---|---|---|---|
| 1 | README cap bullet names the per-value overlay path `subagent-limits-<N>.yml` | TRUE | README.md:125, :137 ↔ src/cli.js:89 `subagent-limits-${max}.yml` |
| 2 | Changelog `### 1.4.0-1` / `### 1.4.0` section split well-formed (pre-1.4.0 card-era bullets under `### 1.4.0`), no orphaned or duplicated headers | TRUE | README.md:174, :179; anchors resolve (Repo Auditor sweep #10) |
| 3 | `retained (...)` wording replaces the failing "unchanged" claim and its retained surfaces exist | TRUE | README.md:175 ↔ resolveCallId (subagent.js:392-419), childRegistry (:95), cancelLineFor (:433-441), pendingCount (:1019→proxy.js:41-49), mergeSnapshots (:755+) |
| 4 | This round's code comments describe the code (nonTaskCalls distrust, post-abort window, disarm, mandate-removal docstring edits) | TRUE | subagent.js:97-112, :196-205, :393-404, :617-627, :747-751 — accurate to behavior at HEAD |

0 FALSE rows.

## Phase 3 — the fleet (all ran within time-boxes; none cancelled; no coverage gaps)

**Red Team** — 6 findings: (1) MEDIUM-HIGH post-sweep adoption of unseen calls re-opens the zombie-card window; (2) MEDIUM unseen active non-task tools are adopted instead of distrusted (phantom card over a real bash card); (3) MEDIUM-LOW window is a no-op on `abort_and_prompt`; (4) LOW stale rule-1/4/5 + `adoptUnseenCall` doc blocks; (5) LOW `writeFileSync` failure leaves `.tmp` debris (rename-failure case covered); (6) LOW changelog split orders `1.4.0-1` above `1.4.0`. Survived: cap parse gauntlet (17 malformed/edge values), double-cancel immunity, armed-window vs sweep's own cancels, shared `seq` namespace, terminal stickiness, disarm substring shapes.

**Code Reviewer** — Critical: none. W1 window arm→instant-disarm on `abort_and_prompt` (static read + probe; corroborates Red Team); W2 stale doc blocks contradict line 405's rule; W3 test honesty: the proxy disarm seam (proxy.js:99-106) has zero coverage — the test calls `bridge.disarmAbort()` directly. I1 window-cancel leaves the per-call entry live (later sweep re-cancels a dead child — harmless per wire note); I2 substring matcher false-disarm surface; I3 `nonTaskCalls` unbounded. Verified README claims: per-value path, atomic write, guard wording. CodeRabbit CLI absent — manual full-diff read, per mandate.

**Security Reviewer** — LOW: (1) uncaught write-after-end on `childIn.write` via `onOmpLine` (CWE-248, ERR_STREAM_WRITE_AFTER_END kills the shim — narrow reachability); (2) substring frame discrimination (CWE-183) — false-disarm vector. Info: (3) `nonTaskCalls` unpruned (CWE-770); (4) predictable tmp filename (CWE-377, no boundary crossed). `npm audit` not possible: no lockfile (ENOLOCK); `package.json` declares **zero dependencies** — empty audit surface. Swept clean: command injection (argv-array spawn only), path traversal/hostile env value (guard verified killing 1e26-style inputs before path/content interpolation), parser/TOCTOU/symlink on overlay write, prototype pollution, deserialization, secrets (control-char-sanitized warning verified), crypto n/a, SSRF n/a, arming exists in the production path (not test-runner-only), no id collisions.

**Scrutinizer (first-hour, docs-only)** — F1 npm/brew still ship 1.3.0-4 while the seal documents 1.4.0-1 behavior (publish-state, manual per repo policy — owner action item); F2 no complete wrapper example wires OMPT3_MAX_SUBAGENTS to Setup's Binary Path; F3 `update` subcommand half-documented; F4 help text omits the promised stderr warning. Execution-verified: `--version`, `--check` (606 models / 275 KB, symlink OK), `--help`, anchors. Verdict line: first hour delivers where executable; the new cap feature has no wired first-hour path.

**Repo Auditor (cross-layer)** — MED: (1) README.md:182 changelog card still claims snapshot merge keeps "mandates" — field deleted this round; (2) README.md:183 still claims `exitCode:1` — no plumbing in src/ outside updater.js; (3) no changelog entry anywhere describes this round's own behavior (window, adoption); RELEASE_NOTES-v1.4.0-1.md's "known non-blocking findings" are now fixed, notes stale for any re-publish. LOW: cli.js doc block lags the `Number.isSafeInteger` guard. PASS rows: README §Limiting body ↔ cli.js:87-141 exact match (pinned test/cli.test.js:164); "retained" surfaces all present; this round's doc blocks accurate. Sweeps: no orphaned headers, no duplicate implementations (`cancelLineFor` unified), `subagent-limits.yml` (unnumbered) fully purged. Coverage: read deeply diff+seams; never opened updater.js internals, model_catalog, commands, e2e, specs/.

**Ponytail** — proxy.js:L100 `shrink` 4-way `.includes` → one regex; subagent.js:L427 `yagni` `disarmAbort()` (~9 lines vs inline field write). `net: -13 lines possible` — modest; no claims-truth signal. Cancel-line unification, cap guard, rmSync, and the 74 test lines all lean; not flagged.

## Phase 4 — findings verification (gate keeper re-ran every load-bearing P2 reproduction first-hand)
Probes in /tmp/opencode/gkverify/probe.js against committed `src/subagent.js`:

1. **Post-sweep unseen-parent adoption (confirmed, MEDIUM-HIGH/P2)** — after `abortSweep`, a late `subagent_lifecycle` with unseen parent `callZ` is adopted: bridge emits a live card update (`0/1 done · running: scout`) for a child the registry simultaneously declared cancelled (`Z1`, cancel sent), leaves `callZ` in `taskCalls`/`openCalls`/`subagentsByCall` with no synthetic end in this abort, `pendingCount()` 0. A card can post-`tool_execution_end` as open on the interrupted turn (T3 finalizes without sweeping late frames — the exact incident window this round's hardening targets). A *later* sweep closes it (`sweep2` closes callZ, re-cancels dead Z1).
2. **Unseen active non-task tool adoption (confirmed, MEDIUM/P2)** — late child pinned to unseen `bash_7` is adopted (`taskCalls` + `openCalls`): synthetic frames labeled `toolName:"task"` and a sweep `tool_execution_end` land on T3's real bash card. Same family as round-1 P2-1.
3. **`abort_and_prompt` window no-op (confirmed, MEDIUM/P2)** — the synchronous handler arms (sweep) then disarms (same frame): `abortArmed === false`; a post-abort straggler registers `live:true` with **zero** cancels on that interrupt variant (plain `abort` path verified working).
4. **Doc/claims staleness (confirmed, LOW/P3)** — resolveCallId JSDoc rules 1/4/5 + `adoptUnseenCall` docstring contradict :405; README:182 "mandates" and README:183 `exitCode:1` have no src/ surface (grep verified).
5. All remaining fleet findings spot-checked: consistent with code; nothing refuted.

## Phase 4 — Architect (joins here)
Verdict: **sound with restrictions.** The premise (post-abort stragglers, orphaned cards, P2-1 misattribution) is right; the change extends the map at the right seams. Architecture findings, consistent with the verified probes: **A1 [HIGH]** default-trust-unless-seen-non-task attribution rebuilds P2-1's over-trust surface facing the miss direction — denylists only distrust what was observed; make adoption consumer-verified or corroboration-gated. **A2 [HIGH]** the window is a boolean toggled between frames, not a run epoch — it cannot express its own premise (`abort_and_prompt` is one frame that is both arm and disarm); correct shape is an epoch counter captured by the sweep. **A3 [MEDIUM-HIGH]** cancel-on-observation corrects only the registry — the calls-map entry and `openCalls` are not driven by it (consequence: verified finding 1). **A4 [MEDIUM]** the second omp-stdin write path (`onOmpLine`) carries none of the pipeline's lifecycle handling. **A5 [LOW]** docs-teaching-unbuilt-shapes lineage, fourth appearance. No mutual exclusions; rollback clean (single commit, default-off unchanged… note: both new mechanisms are live on their paths, not knobs).

## Phase 5 — verdict computation
- Confirmed P0/P1: **none** (noCriticals from any reviewer; worst confirmed defects are MEDIUM, same-family calibration as round 1's P2-1; no data loss, no crash on nominal paths, no security finding above LOW).
- FALSE task-truth rows: **none** (4/4 TRUE).
- Material conflicts: **none** (Architect consistent with verified probes; all three probe phenotypes reproduced identically by two independent parties).
- → **PASS**, with findings recorded below for the owner's repair loop (three P2 mechanism defects; do-proceed does not mean do-ignore).

## Findings (consolidated, one line each)

**P2 (confirmed, repair-recommended next round):**
- **P2-1 [MED-HIGH src/subagent.js:405, :268/:767]** post-sweep unseen-parent adoption re-opens zombie/phantom-card window: live card + open call for an already-cancelled child on the interrupted turn (probe-verified ×2 parties).
- **P2-2 [MED src/subagent.js:405]** unseen *active non-task* tool (missed bash/wait start) adopted as task call — synthetic `task` frames and sweep end land on a real foreign card (probe-verified ×2).
- **P2-3 [MED src/proxy.js:91-106]** post-abort cancellation window is a no-op on `abort_and_prompt` (arm and disarm in one synchronous handler); stragglers on that path register live uncancelled (probe-verified ×2). Architect's shape fix: run-epoch counter, not a boolean.

**P3 (confirmed, optional):**
- P3-1 stale resolveCallId JSDoc rules 1/4/5 + `adoptUnseenCall` "only reachable while no task call was ever seen" (subagent.js:361-386, :632-646) contradict :405.
- P3-2 README.md:182 changelog card claims "mandates" — field deleted from snapshot merge this round.
- P3-3 README.md:183 claims `exitCode:1` — no plumbing in src/ outside updater.js.
- P3-4 no changelog entry describes this round's own behavior (window, adoption); RELEASE_NOTES-v1.4.0-1.md "known findings" now stale for re-publish (Repo Auditor).
- P3-5 `writeFileSync` (ENOSPC) failure leaves `subagent-limits-<N>.<pid>.tmp` debris — cleanup covers renameSync only (cli.js:130-136).
- P3-6 bridge `onOmpLine` write to omp stdin has no `error` listener on that stream — write-after-end kills the shim (CWE-248, narrow window) (proxy.js:63; subagent.js:620-627).
- P3-7 substring disarm matcher (4 literals, proxy.js:99-106) can false-disarm on a future frame echoing the literal; one regex covers all forms (Ponytail).
- P3-8 the proxy disarm seam has zero test coverage — subagent.test.js:925-928 calls `disarmAbort()` directly (Code Reviewer W3).
- P3-9 `nonTaskCalls` grows unboundedly, never pruned (subagent.js:100/:203 — consistent with `taskCalls`' non-pruning).
- P3-10 window-cancel leaves the per-call entry live; a later sweep re-cancels a dead child (harmless per wire note; entry/registry divergence — subagent.js:309 vs :620-627).
- P3-11 predictable tmp filename (CWE-377, Info — no boundary crossed).
- P3-12 `disarmAbort()` wrapper redundant (~9 lines, yagni); 4-way `.includes` shrinkable to one regex (Ponytail, net −13).
- P3-13 cli.js doc block lags the `Number.isSafeInteger` constraint (cli.js:100-103 vs :120).

**Owner process items (not seal defects):**
- install front door (npm/brew) still serves 1.3.0-4 while the seal documents 1.4.0-1 behavior — publish-state; publishing is a manual owner step (Scrutinizer F1); OMPT3_MAX_SUBAGENTS has no complete wrapper example wiring it to Setup's Binary Path (F2); `update` half-documented (F3); `--help` omits the stderr-warning promise (F4).

**Refuted:** none.

## Gate mechanics audit
- Fresh-session isolation held: every reviewer and the Architect dispatched as fresh T3 delegated sessions (`providerInstanceId: acpRegistry_opencode_v2 / opencode/glm-5.3-flash-free`), mandate files read verbatim, implementer reasoning not shared. Reviewers ran sequentially per restart-hardening; a stale first dispatch on an exhausted provider (`pi`) was detected still running and cancelled before re-dispatch.
- Receipt written by the gate keeper only; no repo file besides this receipt was touched; no commits/branches/tags/pushes; no release operations performed.
