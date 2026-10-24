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
- `omp-t3 --version`: Prints the **Pi base version** on line 1 (what T3's provider gate parses: first `\d+\.\d+\.\d+` token, must be >= `MINIMUM_PI_VERSION` 0.80.5) and the full shim identity on line 2. Derived purely from `package.json` (`<pi>-<iter>` scheme, e.g. `1.3.0-1` -> prints `1.3.0` then `omp-t3 1.3.0-1 (Pi-compatible shim)`). Offline and instant (T3's probe timeout is 4s). No other version-shaped token may appear in the output.
- `omp-t3 --help`: Prints usage instructions and T3 Code configuration guide.
- `omp-t3 --setup-symlink`: Creates symlink `~/.pi/agent/sessions` -> `~/.omp/agent/sessions` for historical usage dashboard discovery.
- `omp-t3 --check`: Verifies `omp` binary in PATH, runs test model extraction, and validates compatibility.

### Scheme D: Opt-in subagent concurrency cap (`OMPT3_MAX_SUBAGENTS`)
When the environment variable holds a plain decimal positive integer N (`/^\d+$/`), the shim atomically writes `~/.cache/omp-t3/subagent-limits-<N>.yml` (`task:\n  maxConcurrency: N` — one immutable file per distinct cap via temp+rename, so concurrent shims never overwrite each other and a symlink at the target is replaced, not followed) and appends `--config <that file>` to the spawned argv — the only argv rewrite besides `--mode`. omp enforces `task.maxConcurrency` in its task-tool semaphore (excess spawns queue) and reports the limit in its own system prompt, so both enforcement and model communication are omp-native. `--config` is repeatable, so user-passed overlays are unaffected. Without the variable — or with an invalid value, which is warned about on stderr (control-character-sanitized) and ignored, or when the cache dir is unwritable (warned; launches WITHOUT the cap — availability over enforcement) — the spawned argv is unchanged, preserving the byte-parity invariant for every default launch. (Live-verified against omp 18.12.3: with the overlay, the model quotes "Max 2 concurrent subagents; excess queue.")

---

## 2. Version Scheme

`package.json` version = `<pi-major>.<pi-minor>.<pi-patch>-<iteration>` (npm-legal encoding of the 4th iteration level; literal 4-segment versions are invalid semver):

- Segments 1-3: the upstream **Pi** release this shim iteration targets (also what `--version` reports to T3's gate).
- Prerelease segment: the shim's **own publish counter** (`1.3.0-1`, `1.3.0-2`, …) — iterate freely without touching the Pi base.
- On a new Pi release: verify the shim against it, then bump the base and reset (`1.4.0-1`).

---

## 3. Process Group & Signal Contracts

- **Child Process Execution**:
  - `child_process.spawn(ompPath, translatedArgs, { stdio: ['pipe', 'pipe', 'inherit'], env: process.env })`
- **Model Catalog Pre-warm**:
  - MUST be asynchronous (`ModelCatalogManager.prewarm`, `execFile` + callback): a synchronous `execSync('omp models --json')` in `spawnAndProxy` stalls every frame (ready, streaming) until discovery finishes (~0.6s with the real binary, up to 8s on a hung child). The pipeline starts relaying immediately; the first `get_available_models` waits on cache-or-sync-fetch as before.
- **Signal Forwarding**:
  - `SIGINT`: Sent to child process via `child.kill('SIGINT')`.
  - `SIGTERM`: Sent to child process via `child.kill('SIGTERM')`.
  - `SIGHUP`: Sent to child process via `child.kill('SIGHUP')`.
- **Exit Status Guarantee**:
  - `omp-t3` exits with `code` when `child.on('close', (code) => process.exit(code ?? 0))`.
