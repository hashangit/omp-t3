# Subagent Model Policy Specification

T3 sessions mediated through `omp-t3` must restrict subagent models according to configurable allow and deny lists, defaulting to the owner's AGENTS.md policy, without silently inheriting parent models or substituting disallowed models.

## Requirements

- FR1: Configurable model allowlist (`OMPT3_SUBAGENT_ALLOWED_MODELS`) and denylist (`OMPT3_SUBAGENT_DISALLOWED_MODELS`), defaulting to allowing only GLM 5.3 Flash, Gemini 3.8 Flash, and DeepSeek V4.1 Flash, and denying GPT Sol, Opus, and GLM 5.3 variants.
- FR2: Case-insensitive whole-ID glob matching supporting catalog IDs and provider prefixes, with denial always taking precedence over allowance.
- FR3: System-prompt guidance injected into `--append-system-prompt` across all launch paths (including fallback, opt-out, and explicit tools).
- FR4: Hard enforcement at the MCP boundary in the adapted T3 extension, rejecting unlisted, denied, or omitted models before `delegate_task` is called, while preserving allowed options untouched.
- FR5: Native `task` tool is blocked whenever model restrictions are active because its internal model resolution cannot be verified upfront.
- FR6: Unreadable or incompatible extension sources or cache write failures refuse the launch safely rather than silently dropping model protection.

## Acceptance Criteria

- SC1: All unit and launcher tests pass covering policy rules, injection, CLI argument preservation, and fallback (`npm test`).
- SC2: Integration checks pass (`npm run check`).
- SC3: Real OMP runtime smoke test verifies that native tasks and denied/missing models are rejected while allowed models pass through with options intact.
- SC4: All behavior and environment configuration are documented in README.md and bin/omp-t3 --help.
