<img src="assets/icon.svg" width="64" height="64" alt="omp-t3 icon">

# omp-t3

Run Oh My Pi inside T3 Code.

T3 Code includes a provider for upstream Pi. Pointing that provider directly at `omp` breaks three things:

1. Turn settlement. `omp` sends `session_settled` when code generation ends, but T3 Code waits for `agent_settled`. Turns stay stuck in an active state.
2. Tool approvals. T3 Code spawns agents with `--mode rpc`. That flag mutes interactive confirmation dialogs in `omp`, so bash and file approval prompts never appear.
3. Model discovery. `omp` lists more than 500 models across 60 providers in a single RPC response. That payload blows past the 1 MB frame limit and kills the connection.

`omp-t3` sits between T3 Code and `omp` over stdio. It translates settlement and compaction frames, synthesizes the subagent and manual-compaction events T3's UI expects, enables `--mode rpc-ui`, prunes and persists the model catalog, watches for contract drift, and forwards normal streaming traffic untouched.

---

## Installation

### With npm

Install globally using npm:

```bash
npm install -g omp-t3
```

### With Homebrew

Install from the tap:

```bash
brew tap hashangit/omp-t3
brew install omp-t3
```

You can also install directly from GitHub without tapping first:

```bash
brew install hashangit/omp-t3/omp-t3
```

### Run without installing

You can test `omp-t3` directly through npx:

```bash
npx omp-t3 --check
```

---

## Setup in T3 Code

1. Open **Settings** -> **Providers** -> **Pi**.
2. Set **Binary Path** to `omp-t3` (or the full path from `which omp-t3`).
3. Leave **Arguments** blank. `omp-t3` defaults to `--mode rpc-ui` automatically.
4. Click **Refresh** to populate your configured models.
5. Select your model and send a message.

---

## Verify your environment

Run the built-in diagnostic check:

```bash
omp-t3 --check
```

The check verifies that:
- The `omp` binary exists in your `$PATH` and responds to CLI queries.
- Model discovery runs and produces a payload well below the 1 MB transport ceiling.
- The session directory link between `~/.pi/agent/sessions` and `~/.omp/agent/sessions` is active, allowing T3 Code's usage view to read historical token metrics.

---

## How it works

```text
+---------------------------------------------+
|                   T3 Code                   |
|  (packages/provider-pi/src/server/adapter)  |
+---------------------------------------------+
                      ^
                      | stdio (JSONL lines)
                      v
+---------------------------------------------+
|                   omp-t3                    |
|  - Rewrites --mode rpc to --mode rpc-ui     |
|  - Translates session_settled to            |
|    agent_settled (+ pendingMessageCount)    |
|  - Intercepts get_available_models, prunes  |
|    heavy schemas, persists last-known list  |
|  - Answers get_commands discovery probes    |
|  - Strips duplicate provider slugs          |
|  - Maps auto-compaction + synthesizes       |
|    manual /compact event cards              |
|  - Bridges subagent frames into live cards  |
|  - Watches for contract drift (watchdog)    |
|  - Passes diffs, tokens, and bash logs      |
|    through as raw bytes                     |
+---------------------------------------------+
                      ^
                      | stdio (JSONL lines)
                      v
+---------------------------------------------+
|                     omp                     |
|               (local binary)                |
+---------------------------------------------+
```

### Protocol translation

- **CLI rewrite:** Converts incoming `--mode rpc` to `--mode rpc-ui` so `omp` emits permission requests instead of suppressing them.
- **Version reporting:** T3's provider probe runs `--version` and requires a semver >= 0.80.5. The shim versions itself as `<pi-major>.<pi-minor>.<pi-patch>-<iteration>` (e.g. `1.3.0-1`): the first three segments track the upstream Pi release it targets, the prerelease counter is the shim's own publish iteration. `--version` prints the Pi base on line 1 (what T3's gate parses) and the full identity on line 2 — fully offline and instant.
- **Settlement mapping:** Captures `prompt_result` status, catches `session_settled`, and emits `agent_settled` with the right `aborted` boolean so T3 Code marks the turn complete. Injects `pendingMessageCount` (from omp's `queuedMessageCount`) into `get_state` responses, which T3's settle probe reads.
- **Compaction mapping:** Renames omp's `auto_compaction_start`/`auto_compaction_end` frames (auto-compaction mid-run) to the Pi names `compaction_start`/`compaction_end`. omp's method-cascade attempts that end `skipped:true` (no result) are dropped entirely — T3 would otherwise render each as "Context compaction failed". For **manual** `/compact`, omp emits no compaction events at all (its RPC handler answers once when done), so the shim synthesizes the `compaction_start`/`compaction_end` event pair around omp's single response — giving T3 Code a live compaction card instead of silence, and keeping omp's benign "Nothing to compact (session too small)" from failing the whole turn.
- **Model catalog pruning:** Queries `omp models --json`, drops pricing arrays and verbose schemas, and returns clean entries with both `data.models` and top-level `models`.
- **Stale-safe model fallback:** Every successful discovery persists the catalog to `~/.cache/omp-t3/models.json`. If live discovery later fails, the shim serves the last discovered list (flagged `stale: true` on the response, with a stderr notice naming the source) instead of a hardcoded guess; a builtin minimal list is the absolute last resort on first run.
- **Contract drift watchdog:** Every cleanly settled turn records the working `omp`/shim versions to `~/.local/state/omp-t3/contract-state.json`. If OMP breaks a protocol promise (e.g. stops emitting `session_settled` after announcing settlement) or discovery dies, the shim keeps the turn alive, prints a stderr banner naming the changed side with rollback guidance, and files a rate-limited issue on GitHub with sanitized diagnostics.
- **Slug normalization:** Strips redundant provider prefixes from model IDs, preventing double-slug lookups like `openrouter/openrouter/...` during model selection.
- **Subagent bridging:** Renames OMP's `task` tool executions to T3's `subagent` convention, merges OMP's live `details.progress[]` child list into the `details.results[]` entries T3's subagent UI reads, and (after opting into `set_subagent_subscription {level:"events"}` on the child's ready frame) translates OMP's `subagent_lifecycle`/`subagent_progress`/`subagent_event` frames into synthesized `tool_execution_update` frames carrying per-child status, model identity, and assistant text — so spawned subagents render as live cards in the T3 thread tree. Child events are always attributed to the `task` call that spawned them (omp attributes late events to whichever tool is currently active, which would leave orphaned never-finishing cards), and child state is pruned when the task call ends. Raw `subagent_*` frames are suppressed (T3's adapter ignores unknown event types).
- **Command & skill menu:** Serves T3's `get_commands` polls from OMP's live catalog (cached from OMP's startup push, refreshed on demand): builtins like `/context`, `/stats`, `/usage`, and `/dump` appear in T3's `/` menu as extension commands, and OMP's skills (already named `skill:*`) land in T3's `$` skill menu with `source:"skill"`. OMP's richer source enum is projected onto Pi's `extension`/`prompt`/`skill` enum. When a command runs, OMP's `command_output` frames are re-emitted as rendered text inside the command-only turn — ANSI-stripped and wrapped in a fenced code block, because T3 renders assistant text as markdown (bare newlines collapse; a fence preserves omp's line-oriented bar-chart layout in monospace) — and the turn is settled from OMP's `data.agentInvoked:false` completion signal, which would otherwise hang, since local-only commands never emit `session_settled` and T3's own idle probe is suppressed once output rendered.
- **Byte passthrough:** Everything else (token streaming deltas, diff streams, approvals, and terminal signals) passes through without JSON parsing overhead.

## CLI

`omp-t3` handles four flags locally; everything else is forwarded to `omp` untouched (only `--mode rpc` is rewritten to `--mode rpc-ui`):

| Command | Behavior |
|---|---|
| `omp-t3 --version` | Prints the Pi base version on line 1 (what T3's gate parses) and the full shim identity on line 2. Package-derived, offline, instant. |
| `omp-t3 --check` | Verifies `omp` is reachable, runs test model extraction, validates compatibility signals, and checks the session-directory link. |
| `omp-t3 --setup-symlink` | Creates `~/.pi/agent/sessions` -> `~/.omp/agent/sessions` for T3 Code's historical usage dashboard. |
| `omp-t3 --help` | Prints usage instructions and the T3 Code configuration guide. |

## Provider errors & retries

Occasionally a turn ends with a red **Provider error** card, typically `ECONNRESET: The socket connection was closed unexpectedly` — a mid-stream drop from the model endpoint (e.g. z.ai). What happens next:

1. omp marks the turn failed (`stopReason:"error"`) and the shim passes the failure through faithfully — by design, real failures are never suppressed.
2. T3 Code's own attempt retry re-runs the whole turn cleanly (the completed reply you see is the retry).
3. The red card remains as the thread's record of the failed attempt. It is not an ongoing problem.

omp also has its own session-scoped auto-retry, which omp-t3 deliberately leaves **off**: a mid-stream retry would re-run a response whose partial output is already committed to your thread, duplicating content. T3's attempt retry is the correct recovery layer for mid-stream drops.

## Development

Run unit and integration tests:

```bash
npm test
```

---

## Changelog

### 1.3.0-3

- **Skills in T3's `$` menu.** OMP's skill catalog (26 skills, named `skill:*`) is now served through `get_commands` with Pi's `source:"skill"`, so they appear in T3 Code's `$` skill picker and run through `prompt` like native skills. Previously the shim answered every `get_commands` with an empty list, leaving both menus empty.
- **OMP builtins in T3's `/` menu.** `/context`, `/stats`, `/usage`, `/dump`, `/jobs`, and the rest of OMP's builtin/custom/extension commands appear in T3's slash menu (mapped to Pi's `extension` source; markdown-backed `custom`/`file` commands map to `prompt`).
- **Local command output renders in T3.** OMP runs builtin slash commands locally and emits `command_output` frames T3 knows nothing about; the shim re-emits each as rendered text inside the command-only turn, ANSI-stripped and wrapped in a fenced code block so T3's markdown renderer keeps omp's aligned bar-chart layout instead of collapsing newlines into a run-on paragraph.
- **Local-only commands settle.** OMP completes local commands with `data.agentInvoked:false` on the RPC response — no `prompt_result`, no `session_settled` — and T3's own idle probe is suppressed once a turn renders output. The shim synthesizes the terminal `agent_settled` from that signal, so `/context` no longer leaves the turn active forever.
- `get_commands` answers now echo the caller's request id with its original JSON type (numeric ids were previously stringified).

### 1.3.0-2

- **Manual `/compact` now renders in T3's UI.** omp's manual `compact()` RPC handler emits no compaction events (it answers once when done), so T3 showed nothing and a benign "Nothing to compact (session too small)" failed the whole turn. The shim synthesizes `compaction_start` on the request and `compaction_end` (result or error) around omp's response.
- **Spurious "Context compaction failed" cards eliminated.** omp's auto-compaction is a method cascade; attempts that end `skipped:true` (no result) are now dropped entirely instead of being forwarded as result-less failures.
- **Stale-safe model catalog.** Successful discovery persists the catalog to `~/.cache/omp-t3/models.json`; on live-discovery failure the shim serves the last discovered list (`stale: true` + stderr notice) instead of a hardcoded guess. Empty catalogs count as discovery failures.
- **Subagent card garbage fixed.** Child events are re-parented to the `task` call that spawned them (omp attributes late events to whichever tool is active, which split one child into several T3 nodes, some never terminating), children reported under the tool name are re-titled to their own id, and child state is pruned when the task call ends.

### 1.3.0-1

- Initial shim under the versioned scheme `<pi-major>.<pi-minor>.<pi-patch>-<iteration>` (package-derived, npm-legal encoding of a 4th iteration level).
- Settlement mapping with `pendingMessageCount` enrichment, `abort_and_prompt` tracking, and the contract drift watchdog (`src/doctor.js`): last-known-good bookkeeping per cleanly settled turn, a settle watchdog that synthesizes `agent_settled` when omp withholds `session_settled`, and rate-limited GitHub issue reports with rollback guidance.
- Model catalog pruning + slug normalization, with a fully asynchronous discovery pre-warm that never stalls the frame pipeline.
- Subagent frame enrichment via `set_subagent_subscription` and compaction type renaming.
- Session-directory symlink for T3 Code's historical usage dashboard.

---

## License

MIT
