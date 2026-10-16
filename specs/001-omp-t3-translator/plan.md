# Implementation Plan: OMP-to-T3 Code Translator Shim (`omp-t3`)

**Feature**: `001-omp-t3-translator`  
**Status**: Ready for Tasks  
**Created**: 2026-10-17  

---

## 1. Technical Context & Stack

- **Target Binary**: `bin/omp-t3` (executable Node.js CLI script).
- **Runtime**: Node.js v20+ (detected: v22.23.3, Linux x86_64).
- **Core Modules**:
  - `src/cli.js`: Argument parsing, mode rewrite, helper flags (`--check`, `--version`, `--help`, `--setup-symlink`).
  - `src/proxy.js`: Bi-directional stdio proxy loop, readline stream handlers, process spawn and lifecycle management.
  - `src/settlement.js`: Settle-probe harmonization (`prompt_result` tracking, `session_settled` -> `agent_settled`).
  - `src/model_catalog.js`: Dynamic model extraction via `omp models --json`, cache management, and safe schema pruning under 500KB.
  - `src/subagent.js`: Event translation for child agent tasks (`task` <-> `subagent`).
  - `src/symlink.js`: Setup utility for linking `~/.pi/agent/sessions` -> `~/.omp/agent/sessions`.
- **Dependencies**: 0 external runtime npm packages; utilizes pure Node standard libraries (`node:child_process`, `node:readline`, `node:fs`, `node:path`, `node:os`).
- **Dev Dependencies**: Node test runner (`node:test`, `node:assert`).

---

## 2. Architecture Diagram

```text
       +---------------------------------------------+
       |                   T3 Code                   |
       |  (packages/provider-pi/src/server/adapter)  |
       +---------------------------------------------+
                            ^
                            | stdio (JSONL lines)
                            v
       +---------------------------------------------+
       |                  omp-t3                     |
       |  +---------------------------------------+  |
       |  | CLI Rewriter: --mode rpc -> rpc-ui    |  |
       |  +---------------------------------------+  |
       |  | Stream Demuxer & Byte Passthrough     |  |
       |  +---------------------------------------+  |
       |  | Settlement Filter:                    |  |
       |  |   prompt_result -> suppress           |  |
       |  |   session_settled -> agent_settled    |  |
       |  +---------------------------------------+  |
       |  | Model Interceptor:                    |  |
       |  |   get_available_models -> cached list |  |
       |  +---------------------------------------+  |
       |  | Subagent Bridge:                      |  |
       |  |   task:subagent:event -> subagent     |  |
       |  +---------------------------------------+  |
       |  | Signals & Exit Code Mirroring         |  |
       |  +---------------------------------------+  |
       +---------------------------------------------+
                            ^
                            | stdio (JSONL lines)
                            v
       +---------------------------------------------+
       |                    omp                      |
       |       (/home/linuxbrew/.linuxbrew/bin/omp)  |
       +---------------------------------------------+
```

---

## 3. Implementation Phases

### Phase 1: Setup & Project Infrastructure
- Initialize `package.json` with `bin` field for `omp-t3`.
- Configure `.gitignore` for node project and build artifacts.
- Setup test harness using `node:test`.

### Phase 2: Foundational Components
- Implement CLI argument rewriter and validation in `src/cli.js`.
- Implement process spawn and signal forwarding in `src/proxy.js`.
- Implement symlink utility in `src/symlink.js`.

### Phase 3: Core User Stories
- **US1**: Turn Settlement Handler in `src/settlement.js`.
- **US2**: Transparent CLI Proxy & Zero-Flag Default in `bin/omp-t3` and `src/proxy.js`.
- **US3**: Model Catalog Discovery & Pruner in `src/model_catalog.js`.
- **US4**: Permission Dialog & Extension UI passthrough.
- **US5**: Subagent Normalizer in `src/subagent.js`.
- **US6**: Live usage passthrough and session symlink helper.

### Phase 4: Polish & Integration Testing
- Automated unit and integration tests covering all protocol frames.
- Live integration verification with local `omp` binary.
- Documentation & user manual in `README.md`.
