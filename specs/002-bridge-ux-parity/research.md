# Research: Bridge Hardening & UX Parity Round

**Date**: 2026-10-23 · **Method**: two read-only scouts against T3 0.1.2's embedded provider-pi source (extracted from the `t3` ELF), omp 18.12.6 CLI/docs/state DBs, live bridge state, and the bridge repo. Verbatim evidence lives in the linked artifacts; this file records decisions.

## R1 — Subagent click-to-open (US1/FR9): **UNSUPPORTED bridge-side**

**Artifact**: [subagent-open-gap-report.md](./subagent-open-gap-report.md)

- Decision: US1 takes the spec's gap-report path. The renderer's whole contract is `childThreadId !== null`; the Pi adapter hardcodes `null` and drops unknown `results[]` fields; omp frames carry no child-session identity. Shipping a look-alike would render a dead button.
- Rationale: honest parity outcome pre-directed by the user ("if possible and if the provider allows") and encoded in FR9's conditional scope.
- Alternatives considered: injecting a child-session reference into `results[]` entries now (rejected — field name unagreed upstream, dead weight today, fork risk later); exposing an MCP tool to read child transcripts (rejected — look-alike, forbidden by spec).
- Bridge disposition: no user-facing change; `src/subagent.js` unchanged and stays pinned; revisit when T3 implements the upstream ask.
- Upstream ask (filed in the gap report): Pi adapter reads optional `sessionPath`/`sessionId` from results[] entries and mirrors `CodexAdapterV2`'s child-thread mechanism.

## R2 — `omp-t3 update --self` (US8/FR2)

**Evidence**: T3 pi driver 0.1.2 (`34.read.log:229-235`): `nativeUpdate: { args: ["update", "--self"] }` resolved against the **user-configured `binaryPath`**, run from the workspace cwd; T3 captures exit code, `timedOut`, combined output; failure = WARN log only (`boot-service.log:4301-4312` shows today's `error: Unknown option '--self'`, exit 1). Live install here is a **symlink into the git checkout** — neither npm-global nor Homebrew.

- Decision (corrected in implementation review): add an `update` subcommand (accepts `--self`, also bare `update`) to `src/cli.js` `parseArgs`, never forwarded to omp. Channel detection via `fs.realpathSync(process.argv[1])` + `npm root -g` (probed only when needed) + Homebrew prefixes (`$HOMEBREW_PREFIX`, `/opt/homebrew`, `/home/linuxbrew/.linuxbrew`). **Every channel defaults to a successful no-op with manual guidance** — a real package-manager update runs only behind explicit user opt-in (`update --yes`); a git checkout is guidance-only even then. Unattended global mutations are unacceptable, and T3 calls this command routinely (WARN-only on failure, so a quiet no-op is the correct daily behavior).
- Rationale: matches T3's invocation contract; unknown-option errors disappear; ambiguity resolves to explicit successful no-op.
- Open (non-blocking): exact T3-side timeout bound (resolver module not in dumps) — keep the command fast; `--yes` paths propagate child exit codes.

## R3 — Approval cache (US5/FR7): **split verdict — naive default-on rejected** → **CUT in review**

**Evidence**: omp mode surface (`docs/approval-mode.md`): config `tools.approvalMode`, flag `--approval-mode <mode>`, modes `always-ask | always-ask-cached | write | yolo` (**yolo is omp's default**); `always-ask-cached` activates omp's own resolver prompts (file reads, write, exec) with cross-session "Always" grants in `approval-cache.db` (agent-global, not per-project); RPC hosts get `Approve File` / `Always Approve File` choices; hosts answering `once/session/deny` keep working. T3's visible gating is **not omp's resolver**: the T3 MCP extension registers a blocking `tool_call` hook keyed on `T3_PI_RUNTIME_MODE` and calls `ctx.ui.confirm` — conversation-scoped, session-scoped repeats.

- Final decision (implementation round): **cut the feature entirely.** Review confirmed the path the plan feared: enabling the cache would only ADD omp-resolver prompts without reaching cross-session approval memory through this bridge — T3's hook stays conversation-scoped regardless, and no in-thread approval-suppression path exists for the bridge to dedupe. Cost (launch-version fork, `--check` complexity, double-prompt gate) outweighed zero benefit. Upstream ask stands as recorded above (T3 answering omp's `{grant, always}`).
- Disposition: no injection, no opt-out flag, no `--check` line; approval dialogs keep the exact feature-001 passthrough (`test/approval.test.js`).

## R4 — Cold-start discovery (US6/FR8)

**Evidence**: 0.1.2 discovery sequence (`31.read.log:2877-2885`): `get_state` (hard) → `get_available_models` (hard) → `get_commands` (soft, `orElseSucceed`). Discovery failure is **non-fatal** (`34.read.log:150-190`): warn, provider stays `ready` with fallback models, live session retries. Workspace `snapshotForCwd` runs a **separate hard `get_commands`** with no soft fallback — T3 blocks the workspace snapshot until an answer arrives; the bridge's bounded answer is what prevents a stall.

- Decision: keep single-flight injection; raise the bounded fallback `refreshTimeoutMs` 2500ms → **10 000ms** (comfortably inside the 30s window, still stall-proof); rely on omp's `available_commands_update` pushes to warm subsequent polls; no other ordering changes.
- Rationale: the 2.5s empty answer was never an error or a stall — worst case was a first workspace slash-menu missing omp commands; 10s trades negligible risk for first-poll completeness (SC6). omp startup speed matters more than the bound (T3 opens several short-lived discovery connections, each a fresh cold cache) — which R5 improves for free.

## R5 — Deferred extension loading (FR12)

**Evidence**: deferral ledger found live: `~/.omp/agent/agent.db` table `cache`, key `extension_startup:v1:<compat-copy-path>`, value `{"fingerprint":"<size>:<mtime-ms>","deferrable":true}`, ~30-day TTL. The compat extension registers tools + event hooks only → deferral-eligible; deferred load completes before the first message executes; tools are not part of T3's discovery RPCs.

- Decision: **do not force eager loading**. Deferred is safe and improves cold start (helps R4/SC6). FR12 verification placement (corrected in review): the ledger assertion lives in `--check` ("Extension deferral" line, `node:sqlite` read, graceful WARN) + the quickstart two-launch scenario — NOT as a live-omp unit test (the suite stays synthetic; live probes belong to `--check`/quickstart per the plan's isolation rule).
- Rationale: forcing eager (e.g. unrecognized flags) would fight omp's design, slow every launch, and violate Zero-Fork for no benefit.

## Cross-cutting decisions

- **Notice channel (FR4/FR5)**: candidates — (a) synthesize Pi's notify pattern (`dynamic_tool` `toolName:"notify"` → T3 0.1.2 renders `system_notice {title}`, mapping evidence `33.read.log:244-258`); (b) `extension_ui_request` kind `notify` (T3 renders natively, auto-expires). **Corrected against the extracted adapter source (implementation round)**: T3 0.1.2 has NO `tool_execution` handler at all — (a) was a live-projection artifact (`33.read.log`), not adapter code, and would have rendered a fake tool card. Landed: **(b) only** — `{"type":"extension_ui_request","method":"notify","message":"…","notifyType":"info"}`, identical to omp's own `ctx.ui.notify` emission; projected to `system_notice` only while a turn is active (`turn !== null` gate), which is exactly why drift notices are written before the synthesized settle and discovery failures notice nothing.
- **Hold-open counts**: the bridge knows pending subagent counts (`src/subagent.js` `pendingCount()`, live unfinished entries across open task calls) and the withheld-settlement fact (`src/settlement.js`); omp exposes no background-job counts (only the `hasPendingAsyncWork` boolean and `prompt_result.sessionSettled:false`). Notice text states subagent counts when known, else "pending background work" — never invents numbers. Hold state resets exactly when `agent_settled` is emitted.
- **Version gate**: (approval cache cut — no gate needed). Deferred-loading verification is runtime-independent (`--check` probes whatever agent.db exists).

## R6 — Phantom subagent rows under parallel fan-out (US9/FR14–FR15): fault isolated, fix designed

**Evidence**: incident thread `5fd61a7a` orchestration DB (six dispatched → ten rows, four with empty payloads and fleet indices 2–5, all under the last-started call); repo fixture `test/subagent.test.js` proves omp emits `subagent_progress` frames with no `parentToolCallId`; the consumer keys subagent nodes `${toolCallId}:subagent:${step}`, so a misattributed child mints a fresh node.

- Decision: replace the last-started-call fallback with the unambiguous-attribution rule (explicit known parent → sole open task call → only task call ever seen → explicit parent when no task-call history; else withhold and request reconciliation). Fleet index stays display-order only.
- Rationale: preserves every pinned single-call behavior (late completion during a later tool call lands on its true parent via rule 1; parentless single-run frames via rules 2–3) while making parallel fan-out structurally unable to misattribute. Reconciliation (R7's mechanism) is the authoritative healer, so withholding costs at most one refresh interval of visibility, never correctness.
- Alternatives considered: hold-and-replay buffer keyed by child id (rejected — extra state for a case snapshots already resolve); post-hoc phantom tagging (rejected — the consumer's nodes cannot be un-minted once written).

## R7 — Zombie "running" rows after finalize (US10/FR16–FR18): consumer-side root cause, bridge-side closure

**Evidence**: T3 0.1.2 Pi adapter `finalizeTurn` runs on `agent_settled` without sweeping open subagent rows, and every later `tool_execution_update` is dropped (`turn === null`) — verified in the extracted adapter source; the incident DB confirms (ten rows running forever).

- Decision: the bridge closes its side synchronously before any settle synthesis (`abortSweep` → terminal updates + one `cancel_subagent` per live child, ordering pinned by tests); the consumer-side finalize sweep is filed as an upstream ask; existing DB zombies are documented, not fake-repaired.
- Rationale: mirrors the consumer's own Codex adapter, which propagates a parent interrupt down to child turns; the ordering rides on `interruptTurn` setting the interrupted flag before sending `abort`, so terminal updates land in the one window where they cannot become zombies.
- Alternatives considered: post-settle updates (dropped by the consumer — useless); bridge-side surgery on the consumer's orchestration DB (rejected — forking consumer state, Zero-Fork violation).
