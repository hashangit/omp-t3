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
- **Subagent concurrency cap (opt-in):** Setting `OMPT3_MAX_SUBAGENTS=<N>` in the shim's environment atomically writes `~/.cache/omp-t3/subagent-limits-<N>.yml` (containing omp's `task: maxConcurrency: N`) and appends `--config <that file>` to every spawned omp. omp natively enforces that setting — its task-tool semaphore queues excess spawns until a slot frees — and derives the "Max N concurrent subagents" line of its own system prompt from the same key, so the lead agent is *told* the limit, not just throttled. See [Limiting concurrent subagents](#limiting-concurrent-subagents). Without the variable (or with a non-plain-integer value, warned and ignored) launches are byte-identical to before.
- **Byte passthrough:** Everything else (token streaming deltas, diff streams, approvals, and terminal signals) passes through without JSON parsing overhead.

### Limiting concurrent subagents

The model policy described below blocks native `task` by default. This cap is useful only when both model lists are explicitly cleared to allow native tasks.

Each omp subagent is an in-process async task sharing omp's single V8 heap. Long fan-out fleets (6+ concurrent reviewers with large transcripts) can exhaust that heap and `SIGABRT` the whole provider scope — capping live children bounds the peak. Native `task` subagents are meant for short parallel work, so the recommended cap is 5:

```bash
# In the environment the T3-launched shim inherits (e.g. a wrapper):
OMPT3_MAX_SUBAGENTS=5 omp-t3   # exec omp-t3 "$@" for a passthrough wrapper
```

What happens: the shim atomically writes `~/.cache/omp-t3/subagent-limits-<N>.yml` (one immutable file per distinct cap, so concurrent shims never overwrite each other) and adds `--config <that file>` to the omp launch. omp queues the 6th+ concurrent `task` spawn (T3 needs no change — queued children simply appear later, and hold-open counts stay truthful) and tells the model "Max 5 concurrent subagents; excess queue." in its system prompt, so disciplined leads dispatch in waves without hitting the queue. The value must be a plain positive integer (`5`, not `0x10`/`1e3`/padded); anything else is warned about on stderr and ignored, and an unwritable cache dir degrades to launching without the cap (never a crash). The cap is per-omp-session, not machine-wide: your direct `omp` terminals keep their own setting.

Long-running delegated work does not belong in native subagents at all: per [AGENTS.md §Subagents](AGENTS.md), use T3's `delegate_task` MCP tool — those children run as T3-owned threads (openable in T3's UI, outside omp's heap) instead of in-process cards.

## Delegation enforcement

By default, `omp-t3` supplies a built-in tool list that excludes OMP's in-process `task` spawner. It appends a system-prompt policy directing delegated work to T3's `delegate_task` MCP tool, where children run in separate, openable threads. The shim removes the native spawner; T3 owns scheduling of delegated threads. `OMPT3_MAX_SUBAGENTS` limits OMP's native tasks only and does not cap T3 `delegate_task` children.

Set `OMPT3_DELEGATE_TASKS=0` to restore the stock tool list and skip the delegation-routing appendix. An explicit `--tools` list, in either CLI form, also takes precedence over tool-list injection and validation. Explicit lists are passed to OMP unchanged, including any validation errors. The separate subagent model policy still applies in both cases and is appended to any user prompt appendix.

For shim-supplied lists, a startup probe waits up to five seconds for OMP's `ready` frame. OMP's singular or plural unknown-tool errors and unavailable-tool errors prune only the named entries, with at most five probes. A timeout, spawn failure, unrecognized error, or empty remaining list falls back to stock tooling with a stderr warning. Fallback preserves user arguments, the concurrency overlay, and the subagent model policy and its blocking hook. The model policy continues to block native `task` on this path.

The probe starts OMP with the launch arguments and agent directory, so configured extensions and MCP servers may initialize during validation as well as during the final launch. Each probe uses its own process group on Unix, which is terminated before the next launch. A `ready` frame validates startup; it does not guarantee model credentials, quotas, or subsequent requests will succeed.

### Restricting subagent models

`omp-t3` defaults to your AGENTS.md model choices. Only `glm-5.3-flash`, `gemini-3.8-flash`, and `deepseek-v4.1-flash` are allowed. The deny rules are `gpt-*sol*`, `*opus*`, `glm-5.3`, and `glm-5.3:*`, covering GPT Sol, Opus, and base GLM 5.3, including its batch variant. The parent model is unaffected.

Set either variable in the environment inherited by `omp-t3` to replace that list:

```bash
export OMPT3_SUBAGENT_ALLOWED_MODELS='glm-5.3-flash,gemini-3.8-flash,deepseek-v4.1-flash'
export OMPT3_SUBAGENT_DISALLOWED_MODELS='gpt-*sol*,*opus*,glm-5.3,glm-5.3:*'
```

Values are comma-separated model IDs or patterns, with `*` as the only wildcard. Matching is case-insensitive and anchored to the whole ID. A rule containing `/` matches the full catalog ID; a rule without `/` matches the final model name. For example, `glm-5.3-flash` matches `openrouter/z-ai/glm-5.3-flash`, while `openrouter/z-ai/glm-5.3-flash` restricts the provider too. Display names such as `GLM 5.3 Flash` are invalid. Whitespace around list entries is ignored. Deny rules always win, even when a model also matches an allow rule.

Exact default rules deliberately exclude aliases such as `glm-flash-latest` and variants such as `glm-5.3-flashx`, dated releases, and `:batch`. Add their exact IDs, or a deliberate wildcard, if you want them. Call `orchestrator_capabilities` to find IDs available in your T3 catalog.

The shim appends these rules to the system prompt on every launch path. A blocking OMP extension checks direct T3 delegation calls, and the adapted T3 MCP client checks again before sending `delegate_task`, including calls through registered tool handlers in scripts. Both T3 tool-name prefixes are covered. Every delegation must set `target.model` explicitly. Omitted, denied, or unlisted models return a tool error before a child starts. Allowed calls retain their provider, model options, and other arguments without rewriting the model.

Native `task` resolves its final model internally, so the hook blocks it while either list is active and directs the agent to T3 delegation. This also applies with `OMPT3_DELEGATE_TASKS=0`, explicit `--tools=task`, or readiness fallback. Unreadable or incompatible bundled T3 extensions, or failure to write the guard files, refuse the launch instead of silently dropping enforcement. A change only to the skill-inlining marker still allows the model guard to load, with a warning about skill inlining.

An explicitly empty value clears that list. An empty allowlist permits any explicit model except those denied; an empty denylist keeps the allowlist. Set **both** variables to empty strings to turn off model restrictions. Combine that with `OMPT3_DELEGATE_TASKS=0` to restore stock native tasks and prompt behavior. Restart the provider session after changing its environment.

This policy covers tools in OMP sessions launched through this shim. It is not a T3 server-wide restriction on other providers, top-level conversations, or arbitrary shell commands.

## CLI

`omp-t3` handles four helper flags plus the `update` subcommand locally. It rewrites `--mode` to `rpc-ui`, applies [delegation enforcement](#delegation-enforcement) by default, and optionally adds the `OMPT3_MAX_SUBAGENTS` config overlay. Other arguments pass through to OMP:

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

**Availability note:** the entries below describe the repository's current `main`. As of this writing, npm's dist-tags still serve `latest: 1.3.0-4` / `beta: 1.4.0` — the 1.4.0-x iterations are pending publish. Until they are published, install from a checkout of this repository (`npm install -g .`) or run `bin/omp-t3` directly.

### 1.4.0-4

- **Launches validate OMP readiness and preserve user arguments.** Default launches disable native `task` and route delegation to T3, and now prove omp actually started: the shim probes the RPC until it answers `{"type":"ready"}` (bounded at 5000 ms per probe, at most 5 convergence rounds). Probes run in their own Unix process group and are terminated on `SIGINT`/`SIGTERM`/`SIGHUP` or timeout. User-supplied `--append-system-prompt` and `--tools` (space and `=` forms) are preserved and merged with the enforcement injection; `OMPT3_DELEGATE_TASKS=0` opts out entirely; the enforcement fallback relaunches with the caller's original argument list. See [Delegation enforcement](#delegation-enforcement).
- **Self-healing `--tools` enforcement.** The injected list no longer names tools omp rejects: `DEFAULT_TOOLS` is the host-valid 15-tool subset, and a pre-flight prune loop re-probes omp before launch, pruning exactly the names omp rejects (singular or plural, ≤5 rounds). If the list still fails, the shim degrades to stock tooling with a stderr warning — availability over enforcement.
- **Delegation enforcement restored.** The `src/cli.js` fixes (`stripInjectedDelegationArgs`, `DEFAULT_TOOLS`/`DELEGATION_POLICY` exports) lost in a worktree cleanup are re-landed, removing the latent `ReferenceError` and the omp exit-2 launch crash class.
- **Disarm seam proven end-to-end.** The e2e pin drives a pre-abort child through the provenance-scoped cancellation window — armed stragglers cancelled, the same provenance spared after the prompt disarms — so the pin fails if the disarm goes missing. Window docs state the final provenance-only semantics. Troubleshooting record: `Reviews/2026-10-24-workflow-troubleshooting.md`.

### 1.4.0-3
- **Adoption is registry-only.** Task calls the bridge never saw start (mid-turn attach, missed start frames) are adopted for attribution, registry cancellation, and hold-open bookkeeping only — no synthetic status/end frames are emitted onto an id T3 may not hold a card for. This fixes two defects introduced by the previous iteration's open-call adoption: a live status card adopted onto an already-cancelled child after the interrupt (zombie window), and an unseen active bash/wait tool being adopted as a task call, which pointed synthetic card frames at a real, unrelated tool card. Adopted ids are tracked in a separate set and can never capture parentless frames via the sole-task-call fallback. **Recorded trade-off:** mid-turn-attached children no longer render live status lines — they remain tracked, counted toward hold-open notices, and are cancelled at interrupt.
- **Cancellation window is provenance-scoped.** After an interrupt (`abort` or the combined `abort_and_prompt`), the sweep records every task-call id known at that moment; while the window is armed (until the next plain prompt), only children belonging to those pre-interrupt calls — with proven ownership — are cancelled on observation. Children of calls opened or adopted after the abort are never cancelled: adoption is not proof of age, and killing a new-turn child is worse than letting a rare old-run straggler finish (it stays tracked, counted toward hold-open, and reconciled post-settle). This fixes the previous iteration's silent no-op on `abort_and_prompt` without re-introducing over-cancellation. A proxy-layer pin drives the seam end-to-end: armed-window stragglers are cancelled, and the same provenance is spared after the prompt disarms.
- **Hygiene:** unpredictable overlay `.tmp` names with cleanup on every failure path; `childIn` stream error listener so a late window-cancel can never kill the shim; `resolveCallId`/`adoptUnseenCall` doc blocks rewritten to the current trust rule; README historical entries reworded. (The `Number.isSafeInteger` cap guard ships in 1.4.0-2, not here.)

### 1.4.0-2

- **Unseen-parent adoption (later superseded).** Task calls the bridge never saw start (shim attached mid-turn) were adopted with open-call rendering and interrupt coverage. Superseded in 1.4.0-3 by registry-only adoption — same tracking and cancellation, without synthesizing frames onto unverified ids.
- **Post-abort cancellation window.** Straggler children surfacing after the interrupt sweep are cancelled on observation instead of running to completion.
- **Hygiene:** `Number.isSafeInteger` cap guard, stderr-warning test coverage, stale comment/doc fixes.

### 1.4.0-1

- **Quick tasks render as tool cards, not fake agents.** omp's `task` subagents no longer masquerade as T3 subagent cards: the `task`→`subagent` rename and `details.results[]` synthesis are gone (task frames pass through byte-identical), and each `task` call instead streams a compact live status line inside its own tool card (child names, models, narration, done/live counts). The interrupt sweep now closes every open task card with one synthetic `tool_execution_end` instead of per-child terminal updates — the phantom-row and zombie-row bug classes (whose root was T3's per-child subagent node keys) are structurally impossible for a generic tool card. Attribution, the live-child registry, `cancel_subagent` hard-kills, hold-open counts, and `get_subagents` reco…
- **Subagent concurrency cap (`OMPT3_MAX_SUBAGENTS`).** Opt-in `--config` overlay setting omp's `task.maxConcurrency` (native semaphore queues excess spawns; omp also tells the lead agent the limit in its system prompt). Recommended 5 — native subagents are short parallel workers; see [Limiting concurrent subagents](#limiting-concurrent-subagents). The per-value atomic overlay file (`subagent-limits-<N>.yml`, temp+rename) also ships here.

### 1.4.0

- **Interrupting a run stops its subagents — on both sides.** T3's Pi adapter finalizes a run on `agent_settled` without sweeping open subagent rows and drops every later frame, so an interrupt used to leave subagent rows `running` forever in T3's database while omp kept executing the detached children invisibly (live incident: 10 gatekeeper-panel subagents stuck as zombies after a Stop). The shim now sweeps synchronously on the upstream `abort`: every live child card is terminalized first (`finished:true, stopReason:"aborted"` → T3 renders *interrupted*) — strictly before the settle synthesis, inside the window where T3's turn still accepts frames — and omp receives one `cancel_subagent` hard-kill per live child before the abort is forwarded. This mirrors how T3's own Codex adapter propagates a parent interrupt down to child turns. Verified against omp 18.12.6 on the wire (`cancel_subagent` returns `cancelled:false` for already-dead children, so races are harmless).
- **Active subagents reconcile against omp's authoritative snapshot.** The bridge now queries `get_subagents` (single-flight, rate-limited, bridge-internal `ompt3-sub-` ids) when the subagent subscription activates, when a new `task` tool call opens, and whenever a run is held open for pending work. The snapshot merges by child id under the same parent-attribution rules as events: it heals spawns the event stream missed and keeps names, model identities, and narration current — and it can never un-finish a child an event already terminalized. All bridge-internal responses are suppressed from T3. (Card-era entry: since 1.4.0-1 these details render in the task card's status line; the registry no longer tracks mandate text or exit codes.)
- **Subagent status mapping completed.** omp's `failed` subagent status now maps to a failed outcome (`stopReason:"error"`) instead of hanging the child at *running* forever — card-era entry; since 1.4.0-1 failed children surface as "N failed/aborted" in the task card's status line.

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
