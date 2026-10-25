# AGENTS.md — omp-t3

## Gatekeeper review gate

Gatekeeper is installed project-locally in the cross-agent skills directory: `.agents/skills/gatekeeper/` (router), `.agents/skills/gatekeeper-review/`, and `.agents/skills/gatekeeper-release/`. Agents that scan `.agents/skills/` natively (Amp, Cursor, Codex, Gemini CLI, Copilot) discover them directly; every agent-specific skills dir — `.claude/skills/`, `.opencode/skills/`, `.codex/skills/`, `.cursor/skills/`, `.gemini/skills/`, `.github/skills/`, `.cline/skills/` — contains symlinks to the canonical `.agents/skills/` copies.

Edit the canonical copies in `.agents/skills/` only — every agent-specific dir is a symlink bridge, so changes propagate. Each skill's `config.sh` is the source of truth, mirrored in its Configuration section.

- **Nobody grades their own exam.** Hand the gate to an independent fresh session; if that isolation is unavailable, the gate reports `BLOCKED`.
- Run the gate on a clean, committed HEAD before any push, version bump, or release cut. Uncommitted implementation changes block it.
- **Review is the default** after implementation. Enter Release only on an explicit user request or explicit confirmation. The gate prerequisite and a PASS never authorize commits, bumps, tags, pushes, publishing, or CI retries.
- Work orders are `specs/<spec>/tasks.md`; every `[x]` claim must be true at the seal, with a `verify:` line per task.
- Review receipts are written to `Reviews/`.
- Reviewer switches: Red Team, Code Reviewer, Security Reviewer, Scrutinizer, Repo Auditor, Ponytail Reviewer, Architect — all **Enabled**.
- **Release (wired 2026-10-23)**: `.github/workflows/release.yml` triggers on `vX.Y.Z` tags (plain semver only — the prerelease `1.3.0-N` scheme ended with 1.3.0-6; 1.4.0 onward is plain `X.Y.Z`). The workflow runs the gates on the tagged source, requires a `Reviews/*-gatekeeper-RELEASE.md` PASS receipt sealed to the release commit's parent, and creates the GitHub Release from the committed `RELEASE_NOTES-vX.Y.Z.md`. npm publishing and the Homebrew tap (`hashangit/homebrew-omp-t3`, formula pulls the npm tarball) stay manual steps performed by the owner. The gate on a clean, committed HEAD still precedes any push, bump, or tag. **Scheme note (owner decision, 2026-10-24):** when npm already holds the plain base (`1.4.0`), subsequent shim iterations resume the `<base>-<N>` prerelease form (`1.4.0-1`, `1.4.0-2`, …) so each publish stays a distinct, npm-legal version; plain `X.Y.Z` remains the form for fresh base drops.

See `.agents/skills/gatekeeper/SKILL.md` for the router and its `references/setup.md` for configuration rules.

## Subagents

For long-running delegated tasks, use T3's `delegate_task` MCP tool (target `providerInstanceId: "pi"`) instead of the native `task` tool so child sessions are created as openable T3 threads.

### Model Restrictions for Subagents

- **Disallowed Models**: **GPT Sol**, **Opus**, or **GLM 5.3** are **strictly not allowed** to be used for subagents.
- **Allowed Models**: Only **GLM 5.3 Flash**, **Gemini 3.8 Flash**, and **DeepSeek V4.1 Flash** are allowed to be used for subagents.
