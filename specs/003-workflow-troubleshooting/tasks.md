# Workflow troubleshooting work order

Base: `23624489fbb70ffe384317c8c6f0719279c61977`.

- [x] Reproduce launcher defects and recover the interrupted review's evidence.
  verify: `Reviews/2026-10-24-workflow-troubleshooting.md` records real OMP errors,
  the failed reviewer event, the broad kill command, and competing explanations.
- [x] Preserve user arguments and make opt-out bypass policy injection.
  verify: `node --test test/delegate-enforcement.test.js test/launcher.test.js`.
- [x] Correct bounded validation, pruning, fallback, and probe cleanup.
  verify: `node --test test/launcher.test.js`.
- [x] Document delegation enforcement and its limits.
  verify: README's Delegation enforcement and CLI sections and `bin/omp-t3 --help`.
- [x] Validate the full suite and real OMP integration.
  verify: `npm test` and `npm run check`; real RPC smoke results are recorded in
  `Reviews/2026-10-24-workflow-troubleshooting.md`.

The independent Gatekeeper verdict is recorded separately after sealing the
committed candidate. It is not claimed complete by this implementation checklist.
