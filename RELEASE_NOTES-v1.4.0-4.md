# 1.4.0-4

Launcher-troubleshooting release: T3 sessions through the shim no longer die at launch — OMP readiness is validated with a closed-loop probe, the injected `--tools` list self-heals against omp's own validator, and user-passed launch arguments are preserved instead of silently replaced. Gatekeeper REVIEW: **PASS** at seal `0cacd23` (R1 receipt: `Reviews/2026-10-24-workflow-troubleshooting-gatekeeper-REVIEW-R1.md` — suite 185/185, fleet 7/7 on Antigravity, 0 P0/P1, 0 FALSE, task truth 5 TRUE / 0 FALSE).

## Readiness-validated launches with preserved arguments

Default launches now prove omp actually started before handing it the session: the shim probes the RPC until it answers `{"type":"ready"}`, bounded at 5000 ms per probe and at most 5 convergence rounds. Probes run in their own Unix process group and are terminated via `process.kill(-pid)` on `SIGINT`/`SIGTERM`/`SIGHUP` or timeout, so an interrupted launch leaves no orphaned omp tree. User-supplied `--append-system-prompt` and `--tools` (space and `=` forms) are preserved and merged with the enforcement injection; `OMPT3_DELEGATE_TASKS=0` opts out entirely. When enforcement must fall back, the relaunch uses the caller's original argument list, never a mutated one.

## Self-healing `--tools` enforcement

The enforcement list previously named three tools (`python`, `notebook`, `browser`) that omp's validator rejects as non-built-ins — omp exited 2 at launch, killing every T3 session through the shim. `DEFAULT_TOOLS` is corrected to the host-valid 15-tool subset, and a pre-flight prune loop re-probes omp before launch, pruning exactly the names omp rejects (unknown or unavailable-in-session, singular or plural) for at most 5 rounds. If the list still fails, the shim degrades to stock tooling with a stderr warning: availability over enforcement, self-healing across omp versions and hosts.

## Delegation enforcement restored

The `src/cli.js` fixes — `stripInjectedDelegationArgs` and the `DEFAULT_TOOLS`/`DELEGATION_POLICY` exports — were edited into a worktree checkout and destroyed by its cleanup; this restores them. Their absence left `bin/omp-t3`'s prune loop referencing a missing function (latent `ReferenceError`) and kept the three unknown tool names in the launch list (the exit-2 crash class).

## Disarm seam proven end-to-end

The e2e pin now drives a pre-abort child through the provenance-scoped cancellation window: armed stragglers are cancelled, and the same provenance is spared once the next plain prompt disarms the window — the pin fails if the disarm goes missing (the R2 P2-B residual, repaired at the seam). Window docs state the final provenance-only semantics; adopted-arm-era wording removed. Troubleshooting record for the whole incident: `Reviews/2026-10-24-workflow-troubleshooting.md`.

## Known residuals (advisory, non-blocking)

1. **Pre-existing shell interpolation.** `src/model_catalog.js` and the `--check` command interpolate `OMP_PATH` into shell strings; migrating to `execFileSync` is a future maintenance item.
2. **Docs polish.** README's CLI table omits the `update` subcommand row.
3. **npm state at gate time.** dist-tags `latest: 1.3.0-4` / `beta: 1.4.0`; the 1.4.0-x iterations are pending publish — publish with an explicit `--tag` decision.

Install note: until the npm publish lands, install from a checkout of this repository (`npm install -g .`) or run `bin/omp-t3` directly.
