# Feature Specification: OMP-to-T3 Code Translator Shim (`omp-t3`)

**Feature**: `001-omp-t3-translator`  
**Status**: Approved  
**Created**: 2026-10-17  
**Source Specification**: `planning_docs/omp-t3-translator-spec.md`

---

## 1. Overview & Business Value

### 1.1 Summary
The `omp-t3` translator shim is an out-of-process, zero-modification stdio RPC proxy that connects **T3 Code**'s first-class Pi provider adapter (`packages/provider-pi/src/server/adapter.ts`) to **Oh My Pi** (`omp` binary, v18.x+).

It resolves three fundamental protocol mismatches without requiring forks of either codebase:
1. **Turn Settlement Mismatch (T3 Code #19490)**: OMP emits `session_settled` (preceded by `prompt_result`), whereas T3 Code's Pi adapter treats only upstream Pi's `agent_settled` frame as terminal.
2. **Permission & Extension-UI Suppression**: T3 spawns processes strictly with `--mode rpc`, which silences tool confirmation / approval requests in OMP. OMP requires `--mode rpc-ui` to emit approval dialogs.
3. **Transport Frame Limit Overflow**: When T3 queries `get_available_models`, OMP attempts to serialize its catalog of 500+ models across 60+ providers into a single JSON line exceeding its internal 1MB frame limit (`maxFrameBytes: 1048576`), resulting in an RPC crash.

### 1.2 Separation of Concerns & Zero-Fork Principle
- **T3 Code**: Unmodified host. Configures `providers.pi.binaryPath` to point to `omp-t3`.
- **`omp-t3`**: Stateless bidirectional JSONL stdio proxy. Intercepts only targeted divergence frames while passing 95%+ of traffic through untouched.
- **`omp`**: Unmodified agent binary running in `--mode rpc-ui`.

---

## 2. User Stories & Acceptance Criteria

### US1: Turn Settlement & Execution Parity (Priority: P1)
**As a** T3 Code user using OMP as my Pi provider,  
**I want** conversation turns to settle promptly when OMP completes code generation or tool execution,  
**So that** T3 Code marks the turn complete, unfreezes the UI, and persists conversation state.

**Acceptance Criteria**:
- **AC1.1**: When OMP emits `session_settled`, `omp-t3` intercepts it and emits `{"type": "agent_settled", "aborted": <boolean>}` to T3 Code.
- **AC1.2**: If the turn finished normally (OMP emitted `prompt_result` with status `completed`), `aborted` MUST be `false`.
- **AC1.3**: If the turn was aborted via user stop signal (`abort` command or SIGINT), `aborted` MUST be `true`.
- **AC1.4**: OMP's internal `prompt_result` frame is suppressed from T3 Code so it does not trigger unknown frame errors.

### US2: Zero-Flag Transparent CLI Invocations (Priority: P1)
**As a** T3 Code user,  
**I want** to specify `omp-t3` as my `binaryPath` without remembering or configuring custom CLI flags,  
**So that** setup is zero-friction and automatically executes with the right operational mode.

**Acceptance Criteria**:
- **AC2.1**: When invoked with `--mode rpc`, `omp-t3` automatically rewrites the flag to `--mode rpc-ui` before spawning `omp`.
- **AC2.2**: When invoked with no arguments, `omp-t3` defaults to spawning `omp --mode rpc-ui`.
- **AC2.3**: All other arguments (such as `--session <id>`, `--fork <id>`, `--hide-thinking`, `--cwd <dir>`) are forwarded to `omp` in their exact order and positions.
- **AC2.4**: Process signals (`SIGINT`, `SIGTERM`) received by `omp-t3` are propagated immediately to the spawned `omp` process group.
- **AC2.5**: When `omp` exits, `omp-t3` exits with the identical exit code and mirrors standard error.

### US3: Safe Dynamic Model Catalog Discovery (Priority: P1)
**As a** T3 Code user,  
**I want** T3's model selector to reliably list available models configured in OMP without crashing or timing out,  
**So that** I can switch between my configured models (e.g. Z.ai GLM-5.3-flash, Claude, GPT-4o, DeepSeek).

**Acceptance Criteria**:
- **AC3.1**: When T3 sends `{"type": "get_available_models", "id": reqId}`, `omp-t3` intercepts the request instead of letting OMP blow past its 1MB RPC frame limit.
- **AC3.2**: `omp-t3` responds with a valid `ModelInfo` array payload:
  `{"id": reqId, "type": "response", "command": "get_available_models", "success": true, "models": [...]}`.
- **AC3.3**: The payload is strictly under 500KB (well below OMP's 1MB limit).
- **AC3.4**: Model discovery extracts available models by querying `omp models --json` (or cached configuration), stripping verbose schema metadata while retaining `id`, `name`, `provider`, `contextWindow`, `maxTokens`, `reasoning`, and `thinking`.

### US4: Interactive Approval & Permission Dialog Bridging (Priority: P2)
**As a** T3 Code user running in Supervised or Auto mode,  
**I want** tool permission dialogs (bash execution, file writes outside workspace) to appear in T3's UI,  
**So that** I can review and approve or deny actions safely.

**Acceptance Criteria**:
- **AC4.1**: `omp-t3` spawns `omp` with `--mode rpc-ui` so OMP emits `extension_ui_request` frames.
- **AC4.2**: `extension_ui_request` frames from OMP are forwarded to T3 Code.
- **AC4.3**: User responses (`extension_ui_response`) from T3 Code are forwarded back to OMP without corruption or delay.

### US5: Subagent Event Bridging (Priority: P2)
**As a** T3 Code user executing multi-agent tasks,  
**I want** child agent tasks spawned by OMP to render natively inside T3 Code's subagent UI,  
**So that** I can inspect child subagent thoughts and tool outputs in real time.

**Acceptance Criteria**:
- **AC5.1**: OMP's subagent events (`task:subagent:event` and `subagent_event`) are captured and normalized to T3's subagent tool card conventions (`subagent`).
- **AC5.2**: Tool calls specifying `task` are bridged with `subagent` identifier where expected by T3.

### US6: Usage & Token Metric Tracking (Priority: P3)
**As a** T3 Code user,  
**I want** per-turn token usage and historical usage analytics to track my consumption accurately,  
**So that** context limits and spend metrics are visible in T3 Code.

**Acceptance Criteria**:
- **AC6.1**: Live turn usage fields (`input`, `output`, `cacheRead`, `cacheWrite`) pass through in `turn_end` / `message_end` frames.
- **AC6.2**: Provide environment parity (`PI_CODING_AGENT_DIR` or setup symlink between `~/.omp/agent/sessions` and `~/.pi/agent/sessions`) to allow T3's historical scraper to index OMP sessions.

---

## 3. Non-Interference Safety Invariants

To guarantee that 95%+ of unchanged OMP/Pi functionality remains completely unaffected:

1. **Invariant 1: Byte-Preserving Passthrough**  
   Any line received on stdout that does not match an explicit interceptor (`session_settled`, `prompt_result`, `get_available_models`, `task:subagent:event`) MUST be passed through directly to T3 Code's stdout as raw bytes, bypassing deserialization and serialization overhead.
2. **Invariant 2: CLI Argument Mirroring**  
   Only `--mode rpc` is rewritten to `--mode rpc-ui`. All other options, flags, and values are preserved in their original order.
3. **Invariant 3: Signal & Exit Code Mirroring**  
   POSIX signals (`SIGINT`, `SIGTERM`, `SIGHUP`) received by `omp-t3` are passed immediately to the child process group. The exit code of `omp-t3` matches the child `omp` exit code.
