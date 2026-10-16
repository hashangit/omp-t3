# Technical Research & Architectural Decisions

**Feature**: `001-omp-t3-translator`  
**Status**: Completed  
**Created**: 2026-10-17  

---

## Decision 1: Runtime Implementation Stack (Node.js Standard Library)

- **Decision**: Implement `omp-t3` as a single-entry executable script using pure Node.js standard library (`child_process`, `readline`, `events`).
- **Rationale**:
  1. **Zero Runtime Dependencies**: Uses only standard built-ins (`node:child_process`, `node:readline`, `node:events`, `node:path`, `node:fs`).
  2. **100% Availability in Target Environment**: T3 Code is an Electron/Node application; every T3 Code installation has Node.js guaranteed.
  3. **Ultra-Low Latency & Memory Footprint**: JSON line proxying in Node.js takes < 0.1ms per frame and < 20MB of RSS memory. Given LLM token streaming takes 20ms–200ms per chunk, proxy overhead is imperceptible.
  4. **Rapid Iteration & Maintenance**: T3 protocol updates or OMP schema additions can be accommodated immediately without compiling or maintaining native cross-compilation toolchains.
- **Alternatives Considered**:
  - *Rust Binary (`cargo`)*: Produces a standalone binary, but requires Rust toolchain to build from source or multi-platform precompiled GitHub release assets for macOS (Intel & Apple Silicon), Linux (x86_64 & aarch64), and Windows. Rejected for Phase 1 as unnecessary complexity.
  - *In-Process Pi Extension*: Fails because T3 launches the process with `--mode rpc`, and in-process extensions cannot alter CLI arguments before process initialization. Furthermore, OMP's `session_settled` event is emitted directly by the root process harness after extensions have finished.

---

## Decision 2: Model Catalog Transport Limit Handling

- **Decision**: Intercept incoming `{"type": "get_available_models"}` RPC requests from T3 Code and satisfy them directly from `omp-t3` using a lightweight cached response populated from `omp models --json`.
- **Rationale**:
  1. When querying `get_available_models` via RPC in OMP v18.x, OMP attempts to serialize its complete internal catalog with tool schemas and parameter descriptors across 60+ providers into a single JSON line. This exceeds OMP's 1MB (`1048576` byte) frame limit, generating `"RPC response exceeded the transport limit"` error.
  2. `omp models --json` executed as a CLI command outputs a compact JSON array (~200KB for all 579 models).
  3. By caching this output at startup or on first request and pruning verbose unneeded fields, the translator returns a clean, compliant `ModelInfo` array (~150KB) that finishes in < 15ms and is guaranteed never to breach frame limits.
- **Alternatives Considered**:
  - *Increasing OMP's internal `maxFrameBytes`*: Would require patching or forking OMP, violating the Zero-Fork Principle.
  - *Hardcoding model list*: Inflexible; would prevent user from seeing newly configured models or local models.

---

## Decision 3: Settle-Probe Harmonization & Turn Settlement

- **Decision**: Track prompt lifecycle in `omp-t3` and translate `session_settled` to upstream Pi's `agent_settled`.
- **Rationale**:
  1. Upstream Pi emits `agent_settled` when the agent turn ends. T3 Code's `packages/provider-pi/src/server/adapter.ts` listens specifically for:
     ```typescript
     if (frame.type === 'agent_settled') {
       settleDeferred.resolve({ aborted: Boolean(frame.aborted) });
     }
     ```
  2. OMP emits `prompt_result` (with `status: "completed" | "aborted" | "error"`), immediately followed by `session_settled`.
  3. When `omp-t3` observes `prompt_result`, it stores `lastPromptStatus = frame.status`.
  4. When `omp-t3` observes `session_settled`, it synthesizes and emits:
     ```json
     {"type": "agent_settled", "aborted": lastPromptStatus === "aborted"}
     ```
  5. It suppresses `prompt_result` so T3 Code doesn't receive unexpected frame types.
- **Alternatives Considered**:
  - *Relying on idle timeout in T3*: Causes multi-minute turn hangs and poor UX.
  - *PR to T3 to accept `session_settled`*: T3 maintainers already rejected and closed #19490 as wontfix.

---

## Decision 4: CLI Argument Rewriting & Default Zero-Flag Mode

- **Decision**:
  - Replace `--mode rpc` with `--mode rpc-ui`.
  - If executed with zero CLI arguments, default to `--mode rpc-ui`.
  - Preserve all other flags in original sequence.
- **Rationale**:
  - T3 Code's Pi provider allows the user to specify `binaryPath: "omp-t3"` and leave arguments blank. T3 automatically appends `--mode rpc`.
  - Rewriting `--mode rpc` to `--mode rpc-ui` un-mutes OMP's extension UI requests, enabling interactive approval modals in T3.

---

## Decision 5: Subagent Mapping

- **Decision**: Map OMP `task:subagent:event` and tool invocations of `task` into Pi-compatible `subagent` updates.
- **Rationale**:
  - T3's UI monitors tool calls named `subagent` to render child agent status cards.
  - OMP uses tool name `task` and emits subagent events over RPC. Normalizing these names ensures T3's subagent visualization operates without modification.

---

## Decision 6: Token Telemetry & Historical Usage Bridge

- **Decision**:
  1. Live turn usage: Passthrough OMP's `usage` payload in `turn_end` and `message_end` (OMP uses `input`, `output`, `cacheRead`, `cacheWrite`, identical to Pi).
  2. Historical dashboard: Support `--init-symlink` flag or automatic symlink creation from `~/.pi/agent/sessions` to `~/.omp/agent/sessions` when run, enabling T3 Code's dashboard scraper (PR #17848) to discover and index historical OMP sessions.
