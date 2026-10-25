# 1.4.0-5

Subagent model restrictions release: `omp-t3` now enforces configurable allowlists and denylists for subagents launched in OMP sessions, defaulting to the repository's AGENTS.md policy. Disallowed and unlisted models are blocked before dispatch, native `task` tools are intercepted, explicit `target.model` is mandatory, and fail-closed protections prevent silent model leakage.

Gatekeeper REVIEW: **PASS** at seal `f74892c629d30386c605a1c42a59a35dba708def` (R1 receipt: `Reviews/2026-10-26-004-subagent-model-policy-gatekeeper-REVIEW-R1.md` — suite 196/196, fleet 7/7 on Antigravity, 0 P0/P1/P2, task truth 5 TRUE / 0 FALSE).

## Subagent model restriction defaults

By default, subagents are restricted to the repository's approved model catalog:
- **Allowed subagent models**: `glm-5.3-flash`, `gemini-3.8-flash`, `deepseek-v4.1-flash`
- **Denied subagent patterns**: `gpt-*sol*`, `*opus*`, `glm-5.3`, `glm-5.3:*`
- Configurable via `OMPT3_SUBAGENT_ALLOWED_MODELS` and `OMPT3_SUBAGENT_DISALLOWED_MODELS`
- Case-insensitive, anchored matching with `*` wildcards. Entries with `/` match provider-qualified IDs; entries without `/` match the model name suffix. Deny rules always win. Setting both variables to empty strings (`""`) cleanly disables restrictions.

## Dual-layer enforcement

Model policy is enforced across two complementary layers:
1. **OMP Tool Execution Hook**: `ompT3SubagentPolicy` registers a `tool_call` interceptor that blocks native in-process `task` execution and blocks direct `delegate_task` calls that attempt to use unlisted or disallowed models. Native `task` is blocked because its resolved model cannot be validated ahead of execution.
2. **Adapted T3 MCP Client Interception**: The shim rewrites `pi-t3-mcp-extension.ts` around `createMcpClient`, wrapping `client.callTool` to intercept `delegate_task` before requests leave the process for MCP. Calls with missing, empty, or whitespace-only `target.model` are blocked upfront to prevent silent parent-model inheritance.

## Fail-closed adaptation & diagnostics

- Launch halts with exit code 1 if extension reading, cache writing, or adaptation fails while model policy is active, ensuring un-enforced sessions never run silently.
- `omp-t3 --check` diagnostic inspects policy compilation and reports active allowed and disallowed model patterns.
- `omp-t3 --help` documents subagent model configuration and environment variables.

## Known residuals (advisory, non-blocking)

1. **Pre-existing shell interpolation.** `src/model_catalog.js` and `--check` interpolate `OMP_PATH` into shell strings; migrating to `execFileSync` remains a scheduled maintenance item.
2. **Docs polish.** README's CLI table omits the `update` subcommand row.
3. **Ponytail shrink items.** 7 minor micro-shrink items (`net: -20 lines possible`) recorded in R1 receipt; kept for explicit error formatting and debug clarity.
4. **npm state at gate time.** dist-tags `latest: 1.3.0-4` / `beta: 1.4.0`; 1.4.0-x iterations pending publish — publish with an explicit `--tag` decision.
