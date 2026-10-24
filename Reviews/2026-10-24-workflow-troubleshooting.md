# Workflow troubleshooting evidence

This is a diagnostic ledger, not a Gatekeeper PASS receipt.

Baseline: `23624489fbb70ffe384317c8c6f0719279c61977`, Linux, Node `22.23.4`,
OMP `18.12.6` at `/home/linuxbrew/.linuxbrew/bin/omp`.

## Observed workflow interruption

The reference thread is `ddd8b26e-e70e-487c-885c-a71cac52e97e`. Its final
Gatekeeper is `thread:delegated-task:command%3Amcp%3Ab4251a21-4aa4-4bb4-b608-2490bab5b8d9%3Adelegate-task%3Aompt3-gate-1.4.0-3-final-r5`.

- Gate activity position 132 executed `pkill -f "rpc-ui"` while its reviewers ran
  through OMP. Position 137 acknowledged killing its own Code Reviewer.
- The first Code Reviewer, suffix `ompt3-gate-r4-codereviewer-1` under command
  `a2ade93b-4d91-4a51-ba5f-6aa19d711b38`, ended at 18:04:23 UTC. Activity
  position 18 says `Pi process exited unexpectedly.`
- The gate launched a replacement reviewer at 18:05:36 UTC. At inspection,
  18:18 UTC, that reviewer was running with recent source/probe activity. An
  active child is not a completed review or a demonstrated lost notification.
- The Red Team completion had already resumed the gate into its second run at
  18:01:43 UTC. A blanket claim that completion delivery was broken does not fit
  this observation.
- Earlier thread messages also document edits lost when a worktree was removed,
  leaving the launcher referencing a missing helper. The helper was restored in
  baseline `2362448`; that historical missing-export crash is not present there.

## Hypotheses and disproofs

1. Current startup always crashes because of the original invalid tool list.
   Disproved for this host by 173 baseline tests, the integration check, and a
   default launch. The corrected 15-tool list is valid on installed OMP.
2. A completion-notification failure caused every stalled gate. Not established.
   The gate resumed on Red Team completion; an actual process kill explains the
   first Code Reviewer failure. The retry was still working when inspected.
3. The new validation loop handles tool drift and preserves user arguments.
   Disproved by real singular rejection and executable launcher regressions.
4. This is a failed GitHub Actions run. No supporting run exists: `gh run list`
   returned `[]`, `.github/workflows` is absent, and `.github` is ignored.

## Experiment ledger

1. `npm test` at baseline: 173/173 pass. Existing tests did not exercise the
   executable launch validation/fallback boundary.
2. `omp --tools ompt3_missing_tool --mode rpc-ui`: exit 2 and
   `Error: Unknown tool in --tools: ompt3_missing_tool.` The old plural-only
   regex does not match. Two unknown names produce the plural form and do match.
3. Baseline opt-out with `--append-system-prompt USER RULE` still appended the
   delegation policy. The stripping helper erased both the user's tools and
   prompt arguments. These are argument-handling defects independent of quotas.
4. Initial executable launcher tests: five failures and one pass. The early-exit
   case initially encountered a different rejection first; its fixture was
   corrected to isolate exit zero without readiness before final verification.
5. Fixed validation waits for `ready`, reads errors through stream close, prunes
   singular/plural rejections, prevents an empty tool list, and retains original
   user arguments on fallback. Only injected lists are validated. Probe cleanup
   uses recorded process groups, with signal and spawn-error coverage.
6. Final launcher tests replayed against an archive of committed baseline
   `2362448`: 9 failures, 1 pass. Against the fix: 10/10 pass. The full suite
   passes 185/185, `npm run check` passes, and `git diff --check` is clean.
7. Real installed OMP, shim default launch: `ready` followed by successful
   `get_state`, 1230 ms, no degradation warning. Opt-out: same successful RPC
   exchange, 1008 ms, no degradation warning. No model generation was requested.
8. Independent Antigravity audit reproduced the baseline defects against real
   OMP. A second fresh Antigravity session reviewed the working diff and ran the
   185-test suite; it reported no P1/P2 findings. This working-tree review does
   not replace the full Gatekeeper gate on the committed candidate.

## Configuration and release state

The repository-local Gatekeeper installation described by AGENTS.md was absent.
The global installed router was configured for another project. A repository-local
copy is restored under `.agents/skills/gatekeeper`, with `config.sh` and its
Configuration sections agreeing on this repository, the 003 work order, `npm test`,
and `npm run check`. This local installation is ignored by git, as before; it is
not restored automatically by a clone. Release remains unconfigured.

The absent `.github/workflows/release.yml` is also ignored. No release workflow
was created or retried in this task. AGENTS.md's automation description therefore
does not match this checkout.

Tag `v1.4.0-3` resolves to `806954a8d9a5f62dc007b17e2c4609e105dfdb53`, and
the published GitHub Release dates to 16:07:38 UTC. That tag predates baseline
`2362448` and these fixes. Historical REVIEW/RELEASE receipts and release notes
cannot approve the current source. No tag was moved and no package was published.

The local binary symlink already resolves to this checkout's `bin/omp-t3`.
New processes therefore use checkout changes without a package reinstall.
