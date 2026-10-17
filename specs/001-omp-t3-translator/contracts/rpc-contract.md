# Contract: Bidirectional JSONL RPC Protocol

**Feature**: `001-omp-t3-translator`  
**Status**: Completed & Verified  
**Created**: 2026-10-17  

---

## 1. Upstream Interceptor Matrix (T3 -> OMP)

| Match Rule | Action | Output to OMP | Output to T3 |
|---|---|---|---|
| `line` contains `"type":"get_available_models"` | Intercept | None | `{"id": id, "type": "response", "command": "get_available_models", "success": true, "stale": true?, "data": {"models": [...]}, "models": [...]}` — entries carry `id`,`name`,`provider`,`contextWindow?`,`maxTokens?`,`reasoning?`,`thinkingLevelMap?` (never a boolean `thinking`; T3 ignores it). `stale` is present only when the list is not freshly discovered. Fallback order on live-discovery failure: in-memory cache → persisted catalog (`~/.cache/omp-t3/models.json`, written on every successful discovery) → builtin minimal list (absolute last resort, first run only). Every fallback emits a stderr notice naming the stale source. |
| `line` contains `"type":"get_commands"` | Intercept | Warm cache: none. Cold cache: one injected `{"id":"ompt3-cmds-<n>","type":"get_available_commands"} + '\n'` (single-flight; bounded 2.5s fallback answers empty) | `{"id": id, "type": "response", "command": "get_commands", "success": true, "data": {"commands": [...]}}` — served from OMP's live catalog (cached from `available_commands_update` pushes), projected onto Pi's `RpcSlashCommand[]`: OMP `skill` → Pi `skill` (names already `skill:*`, so they land in T3's `$` menu), `builtin`/`extension` → `extension`, `custom`/`file` → `prompt`; `description` always a string; `aliases`/`subcommands`/`input.hint` dropped. The caller's request id is echoed with its original JSON type. |
| `line` contains `"type":"set_model"` | Normalize | `normalized_set_model + '\n'` (redundant `${provider}/` stripped from `modelId`) | None |
| `line` contains `"type":"prompt"` | Record turn start (reset settlement state) | `line + '\n'` | None |
| `line` contains `"type":"abort"` or `"type":"abort_and_prompt"` | Set `aborted = true` | `line + '\n'` | None |
| First `{"type":"ready"}` seen downstream (see §2) | Inject subscription | `{"type":"set_subagent_subscription","level":"events"} + '\n'` | None — sent once per shim process so OMP forwards subagent frames |
| `line` contains `"type":"compact"` | Intercept (synthesize) | `line + '\n'` (untouched) | `{"type":"compaction_start","reason":"user_requested","action":"manual"} + '\n'` — omp's manual `compact()` RPC handler emits **no** compaction events (it awaits the whole compaction and answers once), so the shim synthesizes the Pi start card on request. |
| Any other line (`get_state`, `set_thinking_level`, `set_session_name`, `extension_ui_response`, …) | Byte-Preserving Passthrough | `line + '\n'` | None |

---

## 2. Downstream Interceptor Matrix (OMP -> T3)

Order matters: settlement → command bridge → subagent bridge → passthrough. The contract doctor observes every line (§3) before settlement handling.

| Match Rule | Action | Output to T3 | Output to OMP |
|---|---|---|---|
| `line` contains `"type":"session_settled"` | Intercept & Translate | `{"type": "agent_settled", "aborted": <aborted_status>} + '\n'`; records last-known-good versions (doctor) | None |
| `line` is `{"type":"agent_start"}` (top-level type) | Track (passthrough) | Unchanged | None — opens an agent activity cycle; resets the per-cycle settle and abort flags |
| `line` is `{"type":"agent_end", ...}` (top-level type) while a cycle is open | Intercept (synthesize terminal) | **Original `agent_end` forwarded unchanged**, then `{"type": "agent_settled", "aborted": <true when an upstream abort was seen this cycle or the last recorded prompt status is aborted>} + '\n'` — omp ends every model cycle (prompt turn, steered reply, background-wake reply) with `agent_end` but only follows it with `session_settled` when **nothing** can wake the session again (`prompt_result.sessionSettled === true`). While background jobs or detached subagents are pending, omp withholds `session_settled` until that work drains (minutes, or forever for long-lived servers), which left T3 runs active indefinitely. Settling at the cycle boundary completes the foreground turn; when the background work later drains, omp wakes with a fresh `agent_start` cycle, which T3 adopts as a provider continuation ("Background task completed."). Duplicated settles are safe: T3's settle probe is generation-guarded and finalizes once. Top-level type comparison only — `subagent_event` payloads embed `{"type":"agent_end"}` for child sessions and must reach the subagent bridge | None |
| `line` contains `"type":"prompt_result"` | Intercept & Suppress; arms settle watchdog when `agentInvoked && sessionSettled` (see §3); if `agentInvoked === true` and the cycle was not already settled (no `agent_end` observed — e.g. shim attached mid-turn), synthesizes `{"type":"agent_settled","aborted":<status === "aborted">}` instead of plain suppression | None (records `status`) | None |
| `line` contains `"command":"get_state"` with `success:true` and `data.queuedMessageCount` | Enrich | Same response + `data.pendingMessageCount = data.queuedMessageCount` (T3's settle probe finalizes on this field) | None |
| `line` is `{"type":"response","command":"prompt","success":true,"data":{"agentInvoked":false}}` | Intercept (synthesize terminal) | **Original response forwarded unchanged**, then `{"type":"agent_settled","aborted":<aborted_status>} + '\n'` — local-only slash commands (`/context`, `/stats`, …) complete via the response itself; no `prompt_result` and no `session_settled` ever follow, and T3's command-only idle probe is suppressed once the turn rendered output, so without this the turn stays active forever | None |
| `line` contains `"type":"available_commands_update"` | Intercept & Suppress (cache) | None — cached as the live catalog backing `get_commands`; Pi's dialect is poll-only, so the raw push is never forwarded | None |
| `line` is a response to the injected `ompt3-cmds-<n>` refresh | Intercept (complete pending) | The deferred `get_commands` answer (see §1); raw response suppressed | None |
| `line` contains `"type":"command_output"` | Intercept (render) | `{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":<fenced markdown block>}} + '\n'` — the ANSI-stripped text is wrapped in a fenced code block (fence grows past any inner backtick run): T3 renders assistant text as markdown, so bare newlines collapse into soft wraps and destroy omp's line-oriented bar-chart layout; inside a fence the renderer preserves newlines and uses a monospace face, realigning the bars as omp drew them. Blank output is swallowed, malformed JSON passes through. | None |
| `line` contains `"type":"auto_compaction_start"` | Buffer (suppress) | None | `{"type":"compaction_start", ...}` is **held** until the matching end arrives (see next row) |
| `line` contains `"type":"auto_compaction_end"` | Conditional forward | `held compaction_start + {"type":"compaction_end", ...}` — auto-compaction success carries `result.{summary,shortSummary?,firstKeptEntryId,tokensBefore,...}` (verified against omp 18.11.3 binary + live frames); T3 reads `summary`/`tokensBefore`/`estimatedTokensAfter` (last is absent in omp — optional). Ends with `"skipped":true` (omp's method-cascade attempts: handoff/shake/context-full — this method didn't apply) are **dropped together with their buffered start**: they carry no `result`, and T3 renders any result-less end as "Context compaction failed". Aborted and genuinely-failed pairs (no result, no `skipped`) forward so T3 renders stopped/failed cards. | None |
| `pendingManualCompact && line` is `{"type":"response","command":"compact",...}` | Intercept (synthesize) | None | `{"type":"compaction_end","aborted":false,"willRetry":false,"result":{"summary":data.summary|"Context compacted.","tokensBefore":data.tokensBefore?}}` on `success:true`, or `{"type":"compaction_end","aborted":false,"willRetry":false,"errorMessage":error}` on `success:false`, then the **original response forwarded unchanged** (T3 matches it to clear its in-flight flag and schedule the settle probe). Synthesis order guarantees T3's `sawCompaction` is set, so omp's benign `success:false` ("Nothing to compact (session too small)") renders a failed card instead of failing the whole turn. |
| `line` contains `"type":"subagent_lifecycle"` / `"subagent_progress"` / `"subagent_event"` | Consume & synthesize | `{"type":"tool_execution_update","toolCallId":<parentToolCallId>,"toolName":"subagent","partialResult":{"content":[],"details":{"results":[entries]}}} + '\n'` where entries carry `agent`,`task`,`step`,`finished`,`stopReason?`,`exitCode?`,`model?`,`messages?` (assistant text snapshots — T3's `piSubagentOutput` reads these for card progress/result). Raw `subagent_*` frames are suppressed: T3 ignores unknown event types. **Parent attribution:** the update is anchored to the `task` tool call that spawned the child — omp's explicit `parentToolCallId` is honored only when it is a known `task` call; later tools (`wait`, bash) never steal ownership, so one child yields exactly one T3 node (`<taskCallId>:subagent:<step>`) that always reaches a terminal state. If no `task` call was ever seen (shim attached mid-turn), the explicit parent is anchored as-is. A child reported under the tool name `task` is re-titled to its own id (T3 titles nodes with `agent`). Child state maps are pruned when the owning task call ends. | None |
| `tool_execution_start/update/end` with top-level `toolName:"task"` (or legacy `tool`/`name`) | Rename tool & normalize results | Same frame with `toolName:"subagent"`; `result.details.progress[]` merged into `result.details.results[]` (T3 requires string `agent`+`task` per entry) | None |
| `line` contains `"type":"advisor_cost_changed"` | Suppress | None | None |
| Any other line (`message_update`, `ready`, `turn_end`, `extension_ui_request`, etc.) | Byte-Preserving Passthrough | `line + '\n'` | None |

---

## 3. Contract Drift Watchdog (src/doctor.js)

Runtime detection of upstream contract changes, per the project's drift-prevention policy:

| Signal | Detection | Action |
|---|---|---|
| Clean turn settle | `agent_settled` emitted | Records `{ompVersion, shimVersion, at}` as **last known good** in `~/.local/state/omp-t3/contract-state.json` |
| OMP stops emitting `session_settled` after announcing it (`prompt_result` with `agentInvoked:true && sessionSettled:true`, no `session_settled` within 15s) | Watchdog fires | Synthesizes `{"type":"agent_settled", ...}` so the turn never hangs; stderr banner names the changed side, last-good version, and the rollback command; files a GitHub issue on `hashangit/omp-t3` (once per drift signature per 24h; via `gh` when authenticated, else a prefilled issue URL) |
| Model discovery dies (`omp models --json` unparseable/empty, no cache) | `ModelCatalogManager.onError` | Same report path; T3 falls back to custom models only |

The watchdog NEVER suppresses user-visible failures — it reports *and* keeps the protocol alive.

---

## 4. Byte-Preserving Passthrough Contract

For maximum performance and zero risk of JSON formatting regressions:
1. Lines that do not trigger interceptor conditions MUST NOT be passed through `JSON.parse` or `JSON.stringify`.
2. The raw string or Buffer chunk with newline MUST be piped directly to the corresponding destination stream.
