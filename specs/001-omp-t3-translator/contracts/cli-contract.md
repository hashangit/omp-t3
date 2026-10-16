# Contract: CLI Arguments & Process Invocations

**Feature**: `001-omp-t3-translator`  
**Status**: Completed  
**Created**: 2026-10-17  

---

## 1. Invocation Schemes

The binary `omp-t3` can be invoked in two modes:

### Scheme A: T3 Code Automated Invocation
When invoked by T3 Code's Pi provider:
```bash
omp-t3 --mode rpc [--session <id>] [--fork <id>] [--hide-thinking] [--cwd <dir>]
```
- **Incoming**: `--mode rpc`
- **Rewritten**: `--mode rpc-ui`
- **Output Spawn**: `omp --mode rpc-ui [--session <id>] [--fork <id>] [--hide-thinking] [--cwd <dir>]`

### Scheme B: Standalone / Zero-Flag Invocation
When invoked by the user or script without arguments:
```bash
omp-t3
```
- **Rewritten / Default**: Appends `--mode rpc-ui`
- **Output Spawn**: `omp --mode rpc-ui`

### Scheme C: Management & Helper Flags
Helper flags handled locally without launching a persistent RPC daemon:
- `omp-t3 --version`: Prints `omp-t3` version and detected `omp` version.
- `omp-t3 --help`: Prints usage instructions and T3 Code configuration guide.
- `omp-t3 --setup-symlink`: Creates symlink `~/.pi/agent/sessions` -> `~/.omp/agent/sessions` for historical usage dashboard discovery.
- `omp-t3 --check`: Verifies `omp` binary in PATH, runs test model extraction, and validates compatibility.

---

## 2. Process Group & Signal Contracts

- **Child Process Execution**:
  - `child_process.spawn(ompPath, translatedArgs, { stdio: ['pipe', 'pipe', 'inherit'], env: process.env })`
- **Signal Forwarding**:
  - `SIGINT`: Sent to child process via `child.kill('SIGINT')`.
  - `SIGTERM`: Sent to child process via `child.kill('SIGTERM')`.
  - `SIGHUP`: Sent to child process via `child.kill('SIGHUP')`.
- **Exit Status Guarantee**:
  - `omp-t3` exits with `code` when `child.on('close', (code) => process.exit(code ?? 0))`.
