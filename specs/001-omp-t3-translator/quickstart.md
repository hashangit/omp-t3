# Quickstart & Verification Guide

**Feature**: `001-omp-t3-translator`  
**Status**: Completed  
**Created**: 2026-10-17  

---

## 1. Quick Verification Scenarios

### Scenario 1: CLI Health Check & OMP Detection
Run:
```bash
./bin/omp-t3 --check
```
**Expected Output**:
- Confirms `omp` binary path (e.g. `/home/linuxbrew/.linuxbrew/bin/omp`).
- Confirms `omp` version (e.g. `omp/18.11.1`).
- Queries and prints count of discovered models (e.g. `Discovered 579 models`).

### Scenario 2: Zero-Flag Invocation Rewriting
Run:
```bash
./bin/omp-t3 --version
```
**Expected Output**:
- Prints `omp-t3 v1.0.0 (OMP shim for T3 Code)`.

### Scenario 3: Automated Protocol Loopback Test
Execute test runner:
```bash
npm test
```
**Verifications Performed**:
1. CLI argument rewriter (`--mode rpc` -> `--mode rpc-ui`).
2. Settle-probe translation (`session_settled` -> `agent_settled`).
3. Normal vs aborted turn status tracking.
4. Model catalog interception (payload under 500KB, valid schema).
5. Byte-preserving passthrough for tool calls, text deltas, and permissions.
6. Signal propagation & exit mirroring.

---

## 2. T3 Code End-to-End Setup

1. Open **T3 Code** -> **Settings** -> **Providers** -> **Pi**.
2. Set **Binary Path** to the absolute path of `omp-t3`:
   ```text
   /var/home/hash/.t3/projects/omp-t3/bin/omp-t3
   ```
   (or install globally via `npm link` or `npm install -g .` so it resolves in `$PATH`).
3. Leave **Arguments** empty (or blank).
4. Click **Refresh** to populate models (Z.ai GLM-5.3-flash, Claude, etc.).
5. Start a new turn in T3 Code and observe instant turn settlement and streaming text!
