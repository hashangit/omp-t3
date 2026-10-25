# Subagent model policy work order

Base: `4c785252110a20b9af8ea2612ae41506cda110ad`.

Implement both configurable model lists, defaults matching the owner's AGENTS.md,
system-prompt guidance, and rejection at the OMP/T3 delegation boundary. Denial
wins over allowance. Never silently substitute a model or inherit the parent.

- [x] Add both environment variables, defaults, matching rules, and explicit-model validation.
  verify: `node --test test/subagent_policy.test.js` covers defaults, independent list overrides, qualified IDs, wildcards, denial precedence, malformed lists, and clearing lists.
- [x] Inject model guidance and a blocking extension on every launch path.
  verify: `node --test test/delegate-enforcement.test.js test/launcher.test.js` covers routing opt-out, explicit tools, preserved user appendices, fallback, and refusal when policy files cannot be written.
- [x] Guard delegate_task in the adapted T3 MCP client and refuse unguarded adaptation failures.
  verify: `node --test test/subagent_policy.test.js test/launcher.test.js` covers the executable call boundary, untouched allowed options, extension flag forms, source drift, unreadable source, and cache failures.
- [x] Document defaults, configuration, precedence, native-task blocking, scope, and complete opt-out.
  verify: `README.md` section "Restricting subagent models" and `./bin/omp-t3 --help` describe the implemented behavior.
- [x] Validate the full suite and real OMP runtime without paid calls or real children.
  verify: `npm test`, `npm run check`, and `node test/smoke-subagent-policy.js`; results are recorded in `Reviews/2026-10-25-subagent-model-policy-validation.md`.
- [ ] Obtain an independent Gatekeeper Review on a clean, committed candidate.
  verify: A separate Gatekeeper REVIEW receipt must seal the committed implementation. Working-tree validation is not a gate PASS.
