# Gatekeeper REVIEW — feat/subagent-concurrency-cap (round 2)

```
Mode: REVIEW
Scope: feat/subagent-concurrency-cap (no work order — direct owner request; stated claims graded per gate brief) | Base: fc354e0
Branch: feat/subagent-concurrency-cap | Seal: ec52b29 | Gates: suite 152/152 (npm test, 0 fail 0 skip), probes N/A, examples N/A, build N/A, CI N/A (none configured)
Fleet: Red Team, Code Reviewer, Security Reviewer, Scrutinizer, Repo Auditor, Ponytail Reviewer, Architect (all 7 enabled; all ran to completion, none timed out; CodeRabbit CLI unavailable — manual read substituted, noted by reviewer)
Task truth: 4 TRUE / 2 PARTIAL / 1 FALSE
Findings: P0:0 P1:2 P2:9 (all confirmed first-hand by the gate keeper; 1 fleet claim refuted) + P3/pre-existing observations
Verdict: FAIL
```

Round 1 of this gate died with a silent provider restart (nothing inherited); this is a fresh, complete run. Reviewers were dispatched sequentially, time-boxed (~8 min each), via T3 `delegate_task` per AGENTS.md §Subagents.

## Phase 0 — deterministic checks

- `npm test` → **152 pass / 0 fail / 0 skipped** (single run; no flake adjudication needed).
- No build/probes/examples/CI gates configured for this repo (N/A).

## Phase 1 — seal

- Candidate and final SHA: `ec52b29` — identical; tree clean throughout except the pre-existing untracked `.commandcode/` (ignored per gate brief).

## Phase 2 — task truth (no work order; stated claims graded against the seal)

| # | Claim (source) | Grade | Evidence |
|---|---|---|---|
| 1 | README "Limiting concurrent subagents" (README.md:128-139): env → `~/.cache/omp-t3/subagent-limits.yml` → `--config` overlay; invalid warned+ignored; unset → byte-identical argv | **PARTIAL** | Plumbing TRUE (src/cli.js:100-126; probes: `=5`→overlay+argv, unset→`[]`, `banana`/`0`→warned+`[]`; Scrutinizer verified live end-to-end incl. child argv). FALSE half: "The cap is per-omp-session, not machine-wide" (README.md:137) — one fixed shared path, last-writer-wins across concurrent shims (probe: cap 5 then 2 → file reads 2). |
| 2 | README "Task-tool rendering" bullet (README.md:122): byte-identical task frames, no rename/details rewrite, status line via `tool_execution_update` from `subagent_*` + snapshots, `set_subagent_subscription {level:"events"}` opt-in | **TRUE** | src/subagent.js:197-214 (passthrough, observation only), :452-459 (synthesizeStatus), src/proxy.js:151-153; pinned test/subagent.test.js:14-36; subscription frame observed live on the wire by Scrutinizer. |
| 3 | Changelog Unreleased entry 1 (README.md:176): rename/synthesis gone; status line per card; "interrupt sweep now closes **every open task card**"; zombie class "structurally impossible" | **FALSE** (as written) | Core rendering claims TRUE, but the universal sweep claim is falsified: probe `tool_execution_start(task,call_1)` → `abortSweep()` → `toClient: []`, `call_1` left in `openCalls` (src/subagent.js:484-516 iterates `subagentsByCall` only). "Structurally impossible" also conditional (same window; update-after-end emissions). |
| 4 | Changelog Unreleased entry 2 (README.md:177): opt-in overlay, native semaphore, omp tells the model, recommended 5 | **TRUE** | Verified as row 1; omp-side behavior live-verified per contract Scheme D note (omp 18.12.3). |
| 5 | AGENTS.md §Subagents (AGENTS.md:19-21): prefer `delegate_task` for long-running delegated work | **TRUE** | Present at seal; consistent with T3 reality; followed by this gate itself. |
| 6 | cli-contract Scheme D (cli-contract.md:37-38): positive integer → overlay + `--config`; only argv rewrite besides `--mode`; invalid warned on stderr; default byte-parity | **TRUE** | Byte-for-byte match with src/cli.js:100-126 (Code Reviewer + Scrutinizer independently). Nit: `''` silently ignored (early return) where README lumps it into "warned and ignored" — wording, not behavior. |
| 7 | frame-contract §5.0 (frame-contract.md:52-59): byte-identical passthrough; status line shape `<done>/<total> done · running: name (model): note, … · +N` capped; sweep = one synthetic end per open call (`· interrupted`) | **PARTIAL** | Bullets hold within their own scope (§5.1's "with tracked children" is honest); status-line shape+caps verified (src/subagent.js:421-442). Deductions: §5.1's ended-calls "contribute cancellations only" diverges from emitted `tool_execution_update`s for ended calls (P2-3); header/body label "(1.4.0-1)" uses a scheme AGENTS.md declares dead (P2-6). |

## Phase 3 — fleet findings (verbatim summaries) and Phase 4 — first-hand verification

Every load-bearing P1/P2 was re-run by the gate keeper with throwaway probes in `/tmp` (repo untouched). Confirmed = probe reproduced the claimed behavior at the seal.

### P1 (confirmed) — verdict drivers

1. **Open task call with zero tracked children is never closed by the interrupt sweep** [Red Team HIGH; corroborated Code Reviewer W2, Repo Auditor; Architect]. `src/subagent.js:484-516` iterates `subagentsByCall` only; `openCalls` is never iterated alone. Probe: `start(task,call_1)` → sweep → `toClient: []`, call left open. Consequence: interrupt inside the task-start → first-child-observation window (event lag; snapshot rate-limited ≥1s) leaves the card `running` forever post-`agent_settled` — the exact zombie class the sweep exists to kill, re-entering through the untracked-children window. Falsifies README.md:176 "every open task card" + "structurally impossible" (task-truth row 3). Fix direction (Architect): iterate `openCalls`, not the child map.
2. **Valid `OMPT3_MAX_SUBAGENTS` + unwritable cache dir = total shim death** [Red Team HIGH]. `src/cli.js:118-120`: `mkdirSync`/`writeFileSync` unguarded inside `parseArgs`. Probe: `XDG_CACHE_HOME=<mode-500> OMPT3_MAX_SUBAGENTS=4 node bin/omp-t3` → uncaught `EACCES`, exit 1, no omp launch; control without the env launches fine. Invalid values are warned and tolerated; *valid* values hard-crash on environment failure (read-only home, full disk, sandboxed wrapper). `--version`/`--check`/`--help` paths return before the write and are unaffected.

### P2 (confirmed)

3. **Shared overlay file races across concurrent sessions; "per-omp-session" doc false as written** [Red Team MEDIUM; Code Reviewer W1; Repo Auditor; Security Info]. Fixed path `subagent-limits.yml` (src/cli.js:91-95), non-atomic rewrite per launch. Probe: cap 5 then 2 → same `--config` path, file reads 2. Two concurrent T3 shims with different caps: whichever wrote last wins for any not-yet-started omp; truncated read possible mid-write. README.md:137 added in-range claims the opposite. Fix direction: per-session file (pid/mkdtemp) + tmp+rename.
4. **One malformed/lost bridge response permanently disables reconciliation** [Red Team MEDIUM; Code Reviewer I2]. `src/subagent.js:667-680`: `refreshPending` clears only on a `command:"get_subagents"` response. Probe: `handleBridgeResponse({type:"response", id:"ompt3-sub-1", success:false})` → `refreshPending` stays `true` → `refreshRequest()` returns `null` forever. No timeout/reset; snapshot healing and withheld-child attribution silently off for the session.
5. **`tool_execution_update` emitted after `tool_execution_end` (update-after-end)** [Red Team #5/#6; Code Reviewer I1; Repo Auditor #1 vs contract §5.1]. Three reachable paths: (a) end frame's own `details.results[]` children → `pendingOwnerLines` appended after the passthrough end line (src/subagent.js:202-211, 897); (b) steady-state detached children — omp ends the parent call while children run, every later `subagent_progress` synthesizes an update for the closed card (probe: `0/1 done · running: scout: detached work` after end); (c) post-sweep in-flight frames (probe: `1/1 done · 1 failed/aborted` after the sweep's synthetic end). §5.1 says ended calls' children "contribute cancellations only". T3-side handling of update-after-end is unpinned by any test; wire-order violation regardless.
6. **`''` silently ignored; stderr warning has zero test coverage** [Code Reviewer W3]. Probe: `subagentCapArgs('')` → `[]`, empty stderr (README: "non-positive-integer value, warned and ignored"); test/cli.test.js:105-111 asserts only `deepEqual(args, [])` — deleting the `console.error` keeps the suite green.
7. **Integer parsing accepts non-decimal strings** [Red Team LOW]. Probe: `'0x10'` → overlay `maxConcurrency: 16`; `'1e21'` → writes `1e+21` (a YAML 1.1 *string*); `' 5 '` → 5. Claim says "positive integer N".
8. **Version-story drift** [Repo Auditor]. Features sit under `### Unreleased` (README.md:174) while package.json = `1.4.0` and base `fc354e0` is itself the `chore(release): v1.4.0` commit (tags end `v1.3.0-5`); frame-contract §5.0 is labeled "(1.4.0-1)" — a prerelease scheme AGENTS.md:15 declares dead. The pivot is labeled with a version that can never exist.
9. **Post-pivot dead machinery (~120 lines)** [Ponytail; spot-verified by gate keeper]. `exitCode` plumbed through six functions but never read by any renderer/wire path (grep: no reads); mandate `task` field write-only (statusLine renders agent/model/narration only); frozen-step collision machinery (src/subagent.js:626-642 + registry dance) now guards only name order inside a one-line status. Incomplete cutover from the deleted subagent-card layer. `net: -120 lines possible.`
10. **Stale seam comment** [Repo Auditor]. `src/proxy.js:194` still lists "task tool rename" among the bridge's duties; the rename was removed in this range.
11. **"Four flags" undercount retained in an edited sentence** [Scrutinizer; Repo Auditor]. README.md:143 (edited in-range) still says "handles four flags locally"; `bin/omp-t3:43` advertises `update [--self]` and src/cli.js implements it — five local surfaces.

### P3 / recorded, non-blocking

- **Symlink-following overlay write** (CWE-59) — Security Low, demonstrated; requires local write access to the cache dir (same-user malware or mis-permissioned XDG_CACHE_HOME).
- **Raw env value echoed to stderr** (CWE-117) — Security Low.
- **Unbounded `taskCalls`/`childRegistry` growth + O(N²) attach from hostile downstream frames** (CWE-400) — Security Low/hardening; requires a compromised omp (already local-code-exec equivalent).
- **Pre-existing, out of range:** README.md:114 stale `<pi>-<iteration>` version-scheme bullet (binary reports plain 1.4.0); `set_subagent_subscription` response frame reaches T3 stdout (suppression contract scopes to `ompt3-sub-*`; broader README:180 wording predates this range); undocumented `--check` ledger warning ("run omp-t3 twice unchanged").
- **Refuted (fleet claim, tested):** "parse-time overlay write on helper invocations with extra args" — `--check extra`, `--version --foo`, `--setup-symlink x` all return their local action before the write; no side effect. No parse-time write exists off the proxy path.

### What held (fleet + gate keeper)

Byte-identical task passthrough (no rename, no `details` rewrite — pinned byte-exact); invalid env values warned+ignored with argv byte-parity; terminal stickiness and ownership immutability (no un-finish, no owner renegotiation, conflict → withhold+reconcile); sweep idempotency over tracked calls; cancel dedupe; abort ordering (sweep before settle synthesis, src/proxy.js:56-60); attribution ordered rule identical to base (`resolveCallId`, `registerObserved`, `pendingCount` byte-identical old-vs-new); cap plumbing matches Scheme D byte-for-byte; dependency surface: zero runtime deps, nothing to audit; no secrets in tree; Scrutinizer: flagship #1 delivered verbatim end-to-end live (omp 18.12.3), flagship #2 machinery present (machinery corroborated on the wire; T3-side rendering unverifiable outside T3 Code).

## Architect (Phase 4)

Premise judged **correct on both counts**: the pivot deletes a fake-representation layer whose consumer (Pi adapter, `childThreadId: null`, post-finalize frame drop) could never honor it — lineage-consistent; the cap reuses omp's native knob, bridge stays stateless. Recurring mistake classes re-entered, not continued: (1) claims stronger than machinery ("every", "structurally impossible" over conditional machinery — the register's oldest class, same root as the original phantom/zombie incident), (2) docs teaching a shape tests don't build (`''`/warning coverage), (3) single global resource for per-session semantics (overlay file; one design cause behind P1-2 + P2-3). Update-after-end is a one-side-pinned wire guarantee — needs a consumer-side pin or a §5.5-style disclosure. Rollback clean (two independent commits, cap default-off). Full contradiction pass: no mutual exclusions; `attribution/registry/reconciliation remain load-bearing` is true for ownership/cancel but not for exitCode/step-freeze bookkeeping.

## Verdict

**FAIL** — per the referee rules, on three independent grounds:

1. Confirmed P1-1 (childless-open-call sweep gap + falsified universal claim).
2. Confirmed P1-2 (valid env value + unwritable cache → uncaught crash, no launch).
3. FALSE task-truth row (changelog entry 1: "closes every open task card" / "structurally impossible" — not true at HEAD).

The premises are sound (Architect PASS on design); the failures are execution discipline: sweep iteration scope, guarded/per-session persistence, claims written to match machinery, and finishing the cutover. Per gate rules this review stops here — no repairs performed by the gate. Findings go back for repair; a repaired candidate re-enters the FULL gate on a new seal (two-repair limit remains).

— Gatekeeper REVIEW, round 2, 2026-10-24. Seal ec52b29 verified unchanged start-to-finish.
