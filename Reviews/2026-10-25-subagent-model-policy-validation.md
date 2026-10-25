# Subagent model policy implementation validation

Date: 2026-10-25.
Base HEAD: `4c785252110a20b9af8ea2612ae41506cda110ad`.
Work order: `specs/004-subagent-model-policy/tasks.md`.

This records implementation checks against the working tree. It is not an
independent Gatekeeper receipt or a sealed review verdict.

## Results

- `npm test`: PASS, 196 tests, zero failures, zero skips.
- `npm run check`: PASS against OMP 18.12.6. Discovered 607 models and verified
  the session bridge. The new policy compat path has no deferred-startup ledger
  entry yet, so the existing informational warning remains.
- `node test/smoke-subagent-policy.js`: PASS against real OMP 18.12.6. A local
  OpenAI-compatible fake model emitted a native task call, an omitted-model
  delegation, a denied Opus delegation, and an allowed GLM Flash delegation.
  OMP received the model-policy system prompt, returned policy errors for the
  first three calls, and forwarded exactly one request to the local fake MCP
  server. The allowed target, provider, and `thinking: max` option arrived
  unchanged. Both servers were local. No paid API or real delegated child ran.
  The probe used the existing T3 extension from
  `~/.cache/omp-t3/pi-t3-mcp-extension.compat.ts`, restored its original skill
  marker, and adapted a temporary copy. The original remained untouched.
- `git diff --check`: PASS.

The first executable-adapter test exposed replacement-string expansion of
literal `$&` in the embedded policy factory. A minimal parser comparison
reproduced it; a replacement callback preserved the literal source. The
executable adapter and real runtime probes now pass. The old ledger fixture
was updated to include the newly required MCP client marker.

## Behavior and limits

Defaults allow GLM 5.3 Flash, Gemini 3.8 Flash, and DeepSeek V4.1 Flash. Exact
base names exclude moving aliases and unlisted variants. GPT Sol, Opus, and
base GLM 5.3 deny rules take precedence. A delegation must specify its model.
The parent model is unaffected.

Native tasks are blocked while either list is active because their final
model resolves inside OMP. Explicit tool lists, routing opt-out, and readiness
fallback retain the hook and model guidance. The adapted MCP client also
rejects invalid delegations before HTTP, including direct execute-handler
calls. Disabling both lists explicitly restores unrestricted model selection;
disabling delegation routing as well restores stock native tasks.

This is a shim-session policy, not a server-wide T3 authorization boundary or
a restriction on arbitrary shell commands and other providers.

## Gatekeeper status

BLOCKED, before independent review. The implementation is uncommitted and
the checkout also contains the owner's pre-existing AGENTS.md edit and
untracked `.commandcode/` directory. Those files were left untouched.

`.agents/skills/gatekeeper/references/review.md` requires a "clean candidate
tree" and says, "Do not create a commit to satisfy it." No commit, push,
version change, release action, or self-review gate was performed. A fresh
independent reviewer must run Gatekeeper after a committed candidate exists.
