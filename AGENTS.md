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
- **Release (wired 2026-10-23)**: `.github/workflows/release.yml` triggers on `vX.Y.Z` tags (plain semver only — the prerelease `1.3.0-N` scheme ended with 1.3.0-6; 1.4.0 onward is plain `X.Y.Z`). The workflow runs the gates on the tagged source, requires a `Reviews/*-gatekeeper-RELEASE.md` PASS receipt sealed to the release commit's parent, and creates the GitHub Release from the committed `RELEASE_NOTES-vX.Y.Z.md`. npm publishing and the Homebrew tap (`hashangit/homebrew-omp-t3`, formula pulls the npm tarball) stay manual steps performed by the owner. The gate on a clean, committed HEAD still precedes any push, bump, or tag.

See `.agents/skills/gatekeeper/SKILL.md` for the router and its `references/setup.md` for configuration rules.
