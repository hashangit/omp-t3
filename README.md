<img src="assets/icon.svg" width="64" height="64" alt="omp-t3 icon">

# omp-t3

Run Oh My Pi inside T3 Code.

T3 Code includes a provider for upstream Pi. Pointing that provider directly at `omp` breaks three things:

1. Turn settlement. `omp` sends `session_settled` when code generation ends, but T3 Code waits for `agent_settled`. Turns stay stuck in an active state.
2. Tool approvals. T3 Code spawns agents with `--mode rpc`. That flag mutes interactive confirmation dialogs in `omp`, so bash and file approval prompts never appear.
3. Model discovery. `omp` lists more than 500 models across 60 providers in a single RPC response. That payload blows past the 1 MB frame limit and kills the connection.

`omp-t3` sits between T3 Code and `omp` over stdio. It translates settlement and compaction frames, renders omp's `task` subagents as live tool cards with a compact status line, synthesizes the manual-compaction events T3's UI expects, enables `--mode rpc-ui`, prunes and persists the model catalog, watches for contract drift, and forwards normal streaming traffic untouched.

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
- **Settlement mapping (session mirroring):** Captures `prompt_result` status, catches `session_settled`, and emits `agent_settled` with the right `aborted` boolean so T3 Code marks the turn complete. Injects `pendingMessageCount` (omp's `queuedMessageCount` **plus** `hasPendingAsyncWork`) into `get_state` responses, which T3's settle probe reads — pending background jobs and detached subagents hold the run open exactly as long as omp holds the session unsettled. The T3 run therefore *mirrors* the omp session: omp ends every model cycle (prompt turn, steered reply, background-wake reply) with `agent_end` but withholds `session_settled` while background work is pending, so the run stays open across the pause, the wake cycle delivers its results *into* the still-active run, and the translated `session_settled` finalizes it once drained. **Stop always wins:** an abort while a cycle is open synthesizes the terminal from that cycle's `agent_end`, and an abort of a paused run (no cycle open — no `agent_end` will ever come) synthesizes it immediately, so stopping never hangs. Whether the session's pending work survives a stop is T3's call, not the shim's: a graceful interrupt (no runtime restart) leaves it alive for the thread (verified on the wire against omp 18.12.0), while an interrupt that requests a runtime restart terminates the provider process tree and takes the pending work with it (verified live through T3's thread-interrupt API — the tree dies, no rogues remain, and the next message respawns the provider with full session continuity).
- **Compaction mapping:** Renames omp's `auto_compaction_start`/`auto_compaction_end` frames (auto-compaction mid-run) to the Pi names `compaction_start`/`compaction_end`. omp's method-cascade attempts that end `skipped:true` (no result) are dropped entirely — T3 would otherwise render each as "Context compaction failed". For **manual** `/compact`, omp emits no compaction events at all (its RPC handler answers once when done), so the shim synthesizes the `compaction_start`/`compaction_end` event pair around omp's single response — giving T3 Code a live compaction card instead of silence, and keeping omp's benign "Nothing to compact (session too small)" from failing the whole turn.
- **Model catalog pruning:** Queries `omp models --json`, drops pricing arrays and verbose schemas, and returns clean entries with both `data.models` and top-level `models`.
- **Stale-safe model fallback:** Every successful discovery persists the catalog to `~/.cache/omp-t3/models.json`. If live discovery later fails, the shim serves the last discovered list (flagged `stale: true` on the response, with a stderr notice naming the source) instead of a hardcoded guess; a builtin minimal list is the absolute last resort on first run.
- **Contract drift watchdog:** Every cleanly settled turn records the working `omp`/shim versions to `~/.local/state/omp-t3/contract-state.json`. If OMP breaks a protocol promise (e.g. stops emitting `session_settled` after announcing settlement) or discovery dies, the shim keeps the turn alive, prints a stderr banner naming the changed side with rollback guidance, and files a rate-limited issue on GitHub with sanitized diagnostics.
- **Slug normalization:** Strips redundant provider prefixes from model IDs, preventing double-slug lookups like `openrouter/openrouter/...` during model selection.
- **Task-tool rendering:** omp's `task` subagents are quick in-process parallel workers, so they render as what they are — ordinary tool cards in the transcript, one per `task` call, with a compact live status line (`3/6 done · running: Piranha (glm-5.3): reading src/auth · …`) synthesized from omp's `subagent_*` frames (after opting into `set_subagent_subscription {level:"events"}`) and `get_subagents` snapshots. The task frames themselves pass through byte-identical — no rename into T3's `subagent` convention and no fake agent rows (T3's Pi adapter hardcodes `childThreadId: null`, so subagent cards could never be opened anyway; see the [gap report](https://github.com/hashangit/omp-t3/blob/main/specs/002-bridge-ux-parity/subagent-open-gap-report.md)). Child events are attributed to the `task` call that spawned them (omp attributes late events to whichever tool is currently active), and child state is pruned when the task call ends. **Stop and reconciliation:** interrupting a T3 run closes every open task card with a synthetic `tool_execution_end` (`… · interrupted`) and sends omp one `cancel_subagent` hard-kill per live child — mirroring how T3's own Codex adapter propagates a parent interrupt to its children — so an interrupted run can neither leave a hanging card in T3 nor orphaned subagents in omp. Between events, the bridge reconciles against omp's authoritative `get_subagents` snapshot (on subscription activation, on each new `task` call, and while runs are held open), which heals missed spawn events and keeps names, models, and narration current. Long-running delegated work belongs in T3's `delegate_task` children (openable threads) — see [AGENTS.md §Subagents](AGENTS.md) and [Limiting concurrent subagents](#limiting-concurrent-subagents).
- **Command & skill menu:** Serves T3's `get_commands` polls from OMP's live catalog (cached from OMP's startup push, refreshed on demand): builtins like `/context`, `/stats`, `/usage`, and `/dump` appear in T3's `/` menu as extension commands, and OMP's skills (already named `skill:*`) land in T3's `$` skill menu with `source:"skill"`. OMP's richer source enum is projected onto Pi's `extension`/`prompt`/`skill` enum. When a command runs, OMP's `command_output` frames are re-emitted as rendered text inside the command-only turn — ANSI-stripped and wrapped in a fenced code block, because T3 renders assistant text as markdown (bare newlines collapse; a fence preserves omp's line-oriented bar-chart layout in monospace) — and the turn is settled from OMP's `data.agentInvoked:false` completion signal, which would otherwise hang, since local-only commands never emit `session_settled` and T3's own idle probe is suppressed once output rendered.
- **T3 extension adaptation:** T3 injects its bundled MCP bridge as a pi extension (`--extension …/pi-t3-mcp-extension.ts` plus `T3_PI_MCP_EXTENSION_PATH`). That extension's `$name` skill inliner resolves skills through Pi's `command.sourceInfo.path`, while OMP's in-process commands expose the same file as `command.path`, so on stock OMP every prompt mentioning `$name` crashed the handler and the skill body was never inlined. The shim rewrites that one extension entry to a shim-managed copy under `~/.cache/omp-t3/` (identical source except `getCommands()` projects `command.path` into `sourceInfo.path`) and repoints `T3_PI_MCP_EXTENSION_PATH` at the copy, keeping the extension's tool-ownership identity checks working. If a T3 update changes the extension source so the known marker no longer matches, the original is passed through untouched with a stderr warning — `$name` inlining then degrades to the old crash instead of running stale adapted code. Other extensions and the `get_commands` menu projection are untouched.
- **Subagent concurrency cap (opt-in):** Setting `OMPT3_MAX_SUBAGENTS=<N>` in the shim's environment appends `--config ~/.cache/omp-t3/subagent-limits.yml` (containing omp's `task: maxConcurrency: N`) to every spawned omp. omp natively enforces that setting — its task-tool semaphore queues excess spawns until a slot frees — and derives the "Max N concurrent subagents" line of its own system prompt from the same key, so the lead agent is *told* the limit, not just throttled. See [Limiting concurrent subagents](#limiting-concurrent-subagents). Without the variable (or with a non-positive-integer value, warned and ignored) launches are byte-identical to before.
- **Byte passthrough:** Everything else (token streaming deltas, diff streams, approvals, and terminal signals) passes through without JSON parsing overhead.

### Limiting concurrent subagents

Each omp subagent is an in-process async task sharing omp's single V8 heap. Long fan-out fleets (6+ concurrent reviewers with large transcripts) can exhaust that heap and `SIGABRT` the whole provider scope — capping live children bounds the peak. Native `task` subagents are meant for short parallel work, so the recommended cap is 5:

```bash
# In the environment the T3-launched shim inherits (e.g. a wrapper):
OMPT3_MAX_SUBAGENTS=5 omp-t3   # exec omp-t3 "$@" for a passthrough wrapper
```

What happens: the shim atomically writes `~/.cache/omp-t3/subagent-limits-<N>.yml` (one immutable file per distinct cap, so concurrent shims never overwrite each other) and adds `--config <that file>` to the omp launch. omp queues the 6th+ concurrent `task` spawn (T3 needs no change — queued children simply appear later, and hold-open counts stay truthful) and tells the model "Max 5 concurrent subagents; excess queue." in its system prompt, so disciplined leads dispatch in waves without hitting the queue. The value must be a plain positive integer (`5`, not `0x10`/`1e3`/padded); anything else is warned about on stderr and ignored, and an unwritable cache dir degrades to launching without the cap (never a crash). The cap is per-omp-session, not machine-wide: your direct `omp` terminals keep their own setting.

Long-running delegated work does not belong in native subagents at all: per [AGENTS.md §Subagents](AGENTS.md), use T3's `delegate_task` MCP tool — those children run as T3-owned threads (openable in T3's UI, outside omp's heap) instead of in-process cards.

## CLI

`omp-t3` handles four helper flags plus the `update` subcommand locally; everything else is forwarded to `omp` untouched (only `--mode rpc` is rewritten to `--mode rpc-ui`, and `OMPT3_MAX_SUBAGENTS` opt-in adds one `--config` overlay — see [Limiting concurrent subagents](#limiting-concurrent-subagents)):

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

### 1.4.0-1

- **Quick tasks render as tool cards, not fake agents.** omp's `task` subagents no longer masquerade as T3 subagent cards: the `task`→`subagent` rename and `details.results[]` synthesis are gone (task frames pass through byte-identical), and each `task` call instead streams a compact live status line inside its own tool card (child names, models, narration, done/live counts). The interrupt sweep now closes every open task card with one synthetic `tool_execution_end` instead of per-child terminal updates — the phantom-row and zombie-row bug classes (whose root was T3's per-child subagent node keys) are structurally impossible for a generic tool card. Attribution, the live-child registry, `cancel_subagent` hard-kills, hold-open counts, and `get_subagents` reconciliation are unchanged. Long-running delegated work now has a home: AGENTS.md §Subagents directs it to T3's `delegate_task` (openable child threads outside omp's heap).
- **Subagent concurrency cap (`OMPT3_MAX_SUBAGENTS`).** Opt-in `--config` overlay setting omp's `task.maxConcurrency` (native semaphore queues excess spawns; omp also tells the lead agent the limit in its system prompt). Recommended 5 — native subagents are short parallel workers; see [Limiting concurrent subagents](#limiting-concurrent-subagents).

- **Interrupting a run stops its subagents — on both sides.** T3's Pi adapter finalizes a run on `agent_settled` without sweeping open subagent rows and drops every later frame, so an interrupt used to leave subagent rows `running` forever in T3's database while omp kept executing the detached children invisibly (live incident: 10 gatekeeper-panel subagents stuck as zombies after a Stop). The shim now sweeps synchronously on the upstream `abort`: every live child card is terminalized first (`finished:true, stopReason:"aborted"` → T3 renders *interrupted*) — strictly before the settle synthesis, inside the window where T3's turn still accepts frames — and omp receives one `cancel_subagent` hard-kill per live child before the abort is forwarded. This mirrors how T3's own Codex adapter propagates a parent interrupt down to child turns. Verified against omp 18.12.6 on the wire (`cancel_subagent` returns `cancelled:false` for already-dead children, so races are harmless).
- **Active subagents reconcile against omp's authoritative snapshot.** The bridge now queries `get_subagents` (single-flight, rate-limited, bridge-internal `ompt3-sub-` ids) when the subagent subscription activates, when a new `task` tool call opens, and whenever a run is held open for pending work. The snapshot merges by child id under the same parent-attribution rules as events: it heals spawns the event stream missed and keeps names, mandates, model identities, and narration current — and it can never un-finish a child an event already terminalized. All bridge-internal responses are suppressed from T3.
- **Subagent status mapping completed.** omp's `failed` subagent status now maps to a T3 *failed* card (`stopReason:"error"`, `exitCode:1`) instead of hanging the card at *running* forever, and lifecycle mandates read the `description` field omp actually sends (previously cards spawned by `subagent_lifecycle` alone could render without their mandate text).

### 1.3.0-5

- **Runs mirror the omp session instead of settling at the first cycle boundary.** The previous cycle-boundary settle (1.3.0-4) ended the T3 run while background jobs and detached subagents were still pending — and everything that keeps that work alive (the omp process tree) dies whenever T3 tears the run down: stop with runtime restart, thread close, rollback, an unsolicited-activity guard after any prior stop, or three failed settle probes. Live-verified kill test: a pending `sleep 25` background job never wrote its output after the shim was SIGTERM'd or SIGKILL'd. The shim now holds `agent_settled` until omp's real `session_settled`: `get_state` enrichment counts pending async work (`pendingMessageCount = queuedMessageCount + (hasPendingAsyncWork ? 1 : 0)`), so T3's settle probe keeps the run open across the pause, omp's wake cycle streams its results *into* the still-active run, and the drain finalizes it exactly once.
- **Stop always wins — instantly.** An abort during an active cycle synthesizes the terminal from that cycle's `agent_end` (T3 finalizes interrupted turns on `agent_settled`; omp sends no `session_settled` after an abort while work remains). An abort of a paused run — no cycle open, so no `agent_end` will ever arrive — synthesizes the terminal immediately from the upstream frame. Either way the stop is instant; verified live against omp 18.12.0 through `bin/omp-t3`. One boundary worth knowing: T3 interrupts that request a runtime restart terminate the provider process tree, so pending work dies with the tree (verified live through T3's thread-interrupt API — no rogues left behind, and the next message respawns the provider with full session continuity); only graceful interrupts leave pending work running for the thread.
- **Fallback settle tightened.** The `prompt_result`-based settle now fires only for turns whose agent frames were never observed (shim attached mid-turn) *and* only when omp does not report pending work (`sessionSettled !== false`) — turns that ran real cycles settle exactly once, from `session_settled`.

### 1.3.0-4

- **`$name` skill mentions inline instead of crashing.** T3's bundled MCP extension resolves `$name` skill mentions through `command.sourceInfo.path`, but omp's in-process commands expose the same file as `command.path`, so on stock omp every prompt mentioning a skill threw "undefined is not an object" and the skill body was never inlined. The shim now launches a content-addressed adapted copy of that extension (under `~/.cache/omp-t3/`) whose `getCommands()` view projects `command.path` into `sourceInfo.path`, and repoints `T3_PI_MCP_EXTENSION_PATH` so the extension's tool-ownership identity check keeps matching. If a T3 update drifts the extension source, the original passes through with a stderr warning instead of running stale adapted code. Verified live against omp 18.11.3; commands that already carry `sourceInfo` (omp 18.4.4) pass through untouched.
- **Runs no longer hang while background work is pending.** omp ends each model cycle with `agent_end` but only emits `session_settled` once *all* background jobs and detached subagents have drained — and it announces that condition as `prompt_result.sessionSettled:false`, which the shim's watchdog intentionally ignores (it only fires on broken promises, i.e. `sessionSettled:true` with no settle). Any turn that left a background job running (dev servers, watchers, auto-backgrounded long commands) therefore kept its T3 run active forever; steering only appeared to fix it when the pending work happened to drain. The shim now tracks omp's `agent_start`/`agent_end` cycles and synthesizes the terminal `agent_settled` at each cycle boundary, so the foreground turn completes the moment the assistant stops talking. Duplicate settles are safe: T3's settle probe is generation-guarded and finalizes once.
- **Background results reactivate the thread.** With the foreground turn settled, T3 goes idle while omp's job keeps running. When the job finishes, omp wakes with a new `agent_start` cycle; T3 buffers those events and opens a provider continuation ("Background task completed."), adopts the wake turn, and the wrap-up response streams and settles normally — end-to-end verified against live omp 18.11.3 through `bin/omp-t3` (sleep-75 background job: cycle settle at `agent_end`+0.1s, steer settled mid-window, drain → wake → settle, zero raw `session_settled`/`prompt_result` frames leaked).
- **Fallback settle for prompt-only turns.** If a turn's `prompt_result` carries `agentInvoked:true` but no `agent_end` was observed (shim attached mid-turn), the settle is synthesized from the `prompt_result` itself instead of waiting for a `session_settled` that may never come.
- Matched `agent_start`/`agent_end` by top-level type only — `subagent_event` payloads embed child `agent_end` events and must still reach the subagent bridge.

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
