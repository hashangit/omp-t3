<img src="assets/icon.svg" width="64" height="64" alt="">

# OMP-T3: Zero-Fork Translator Shim for T3 Code & Oh My Pi

An out-of-process, zero-modification stdio RPC proxy that seamlessly bridges [T3 Code](https://t3.codes)'s Pi provider adapter with [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp` v18.x+).

---

## Why OMP-T3?

When pointing T3 Code directly to the `omp` binary, three fundamental protocol mismatches break the experience:

1. **Turn Settlement Mismatch ([T3 Code #19490](https://github.com/pingdotgg/t3code/issues/19490)):**  
   OMP emits `session_settled` (preceded by `prompt_result`), while T3 Code's Pi adapter treats only upstream Pi's `agent_settled` frame as terminal. Without this, turns hang indefinitely.
2. **Permission & Extension UI Suppression:**  
   T3 Code spawns agent processes strictly with `--mode rpc`. In OMP, plain `rpc` mode mutes interactive approval dialogs (`extension_ui_request`). OMP requires `--mode rpc-ui` to un-mute permissions.
3. **Transport Frame Limit Overflow:**  
   When T3 queries `get_available_models`, OMP tries to serialize its complete catalog (580+ models across 60+ providers) into a single JSON line exceeding its internal 1MB frame limit (`maxFrameBytes: 1048576`), crashing model discovery.

`omp-t3` resolves all three issues transparently while passing 95%+ of unchanged traffic (diff streams, thinking tokens, bash executions, and rollbacks) through as raw bytes.

---

## Architecture

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
       |  |   get_available_models -> pruned safe |  |
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

## Quickstart & Setup in T3 Code

### 1. Verify Prerequisites
Run the built-in diagnostic check:
```bash
./bin/omp-t3 --check
```
Output:
```text
--- Checking OMP & T3 Integration Status ---
[PASS] OMP binary found at: /home/linuxbrew/.linuxbrew/bin/omp (omp/18.11.1)
[PASS] Model catalog discovery succeeded: 580 models discovered.
       Safe payload size: 94.5 KB (well within 1024 KB RPC limit).
[PASS] Usage Dashboard session bridge verified.
--------------------------------------------
All checks passed! omp-t3 is ready for T3 Code.
```

### 2. Configure T3 Code
1. Open **T3 Code** -> **Settings** -> **Providers** -> **Pi**.
2. Set **Binary Path** to:
   ```text
   /var/home/hash/.t3/projects/omp-t3/bin/omp-t3
   ```
   *(or `omp-t3` if symlinked/installed to `$PATH`)*.
3. Leave **Arguments** blank (no flags required; `omp-t3` defaults to `--mode rpc-ui`).
4. Click **Refresh** to populate your configured models (Z.ai GLM-5.3-flash, Claude, DeepSeek, etc.).
5. Start chatting!

---

## Key Features & Invariants

- **Zero-Flag UX**: User provides zero CLI flags in T3 Code settings; `omp-t3` automatically supplies `--mode rpc-ui`.
- **Byte-Preserving Passthrough**: Non-intercepted frames bypass JSON deserialization and re-encoding entirely.
- **Signal Forwarding**: `SIGINT`, `SIGTERM`, and `SIGHUP` propagate immediately to the child process group.
- **Exit Code Mirroring**: Exits with the exact code returned by `omp`.
- **Session Dashboard Bridge**: Automatically links `~/.pi/agent/sessions` -> `~/.omp/agent/sessions` so T3's native Usage Dashboard indexes your historical OMP token spend.

---

## Development & Testing

Run the test suite:
```bash
npm test
```

Inspect planning and design documentation:
- [Planning Specification](file:///var/home/hash/.t3/projects/omp-t3/planning_docs/omp-t3-translator-spec.md)
- [Feature Specification](file:///var/home/hash/.t3/projects/omp-t3/specs/001-omp-t3-translator/spec.md)
- [Implementation Plan](file:///var/home/hash/.t3/projects/omp-t3/specs/001-omp-t3-translator/plan.md)
- [Task Breakdown](file:///var/home/hash/.t3/projects/omp-t3/specs/001-omp-t3-translator/tasks.md)
