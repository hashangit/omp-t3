# CLI & Launch Contract — Round 2 additions

Extends [feature 001's CLI contract](../../001-omp-t3-translator/contracts/). Everything not listed here is unchanged.

## 1. Self-update subcommand (FR2, US8)

```
omp-t3 update [--self]      # identical behavior; --self accepted for T3's maintenance resolver
omp-t3 update --yes         # explicit opt-in that RUNS the detected channel update
```

- Consumed by the bridge; **never forwarded to omp** (today it leaks through and omp fails with `Unknown option '--self'`).
- T3 invocation contract (evidence: pi driver `nativeUpdate args ["update","--self"]`, run from workspace cwd, exit code + combined output + timeout recorded; failure = WARN log only):
  - Default (`update`, `update --self`): a **successful no-op** — exit 0, print the detected install channel, real install path, and the exact manual update command; never mutates the install.
  - `update --yes` (user opt-in only): performs the detected channel update and propagates its exit code; a git checkout stays advisory even with `--yes` (no package manager to delegate to).
  - MUST finish fast (T3 records `timedOut`); zero-config wakeup per run: `npm root -g` is probed only when the channel answer needs it, Homebrew detection never shells out first.
- Channel detection: `fs.realpathSync(process.argv[1])`
  - path under npm global root → opt-in update is `npm update -g omp-t3`
  - path under a Homebrew prefix (`$HOMEBREW_PREFIX`, `/opt/homebrew`, `/home/linuxbrew/.linuxbrew`) → opt-in update is `brew upgrade hashangit/omp-t3/omp-t3`
  - anything else (git checkout / unknown) → guidance-only always: `git pull && npm install` in the checkout
- Never prints usage/unknown-option errors for `update --self` or any other `update` variant.

## 2. Launch-argument passthrough (FR1)

| Incoming (from T3 / user) | Bridge behavior | omp argv |
|---|---|---|
| `--session <path>` / `--fork <path>` | Forwarded byte-identically (omp accepts both natively — verified 18.12.6 live: a missing path fails with `Error: Session "..." not found.`) | unchanged |
| `--mode rpc` / `--mode=<x>` | Rewritten (unchanged from 001) | `--mode rpc-ui` |
| everything else | Forwarded verbatim (unchanged) | as-is |

- US7 cut in review: no translation exists on either side; the only pinned requirement is the byte-passthrough invariant (`test/cli.test.js` FR1 pin + `test/parity.test.js` in-stream pin).
- Help text: adds the `update [--self]` line; the existing "All other flags … forwarded directly to omp" line is **correct** after the cut (it already names `--session`/`--fork` truthfully) and stays.

## 3. Approval-mode injection — CUT

Cut in review (with US5/FR7): enabling omp's cross-session approval cache cannot reduce prompts through this bridge (T3 has no in-thread approval-suppression path; omp's resolver prompts don't reach an in-thread confirm), and injecting `--approval-mode` adds a launch-time version fork for nothing. No injection, no `--no-approval-cache`, no `--check` line; the upstream ask stays in [../research.md](../research.md) R3. Approval dialogs keep the 001 passthrough behavior unchanged.

## 4. `--check` additions summary

| New line | Content |
|---|---|
| `Self-update channel` | `[INFO] <channel> (<realpath>) — update with: <exact command>` (informational; never fails the check) |
| `Extension deferral` | `[PASS] deferred startup active (fingerprint matches current compat copy)` / `[WARN] deferrable: false` / `[WARN] no ledger row yet — run omp-t3 twice unchanged, then re-run --check`. Source: omp's agent.db `cache` table row keyed `extension_startup:v1:<compat copy path>` (read via `node:sqlite`; graceful WARN when the db or module is unavailable). FR12's two-consecutive-launch live proof: this line + the quickstart scenario. |
