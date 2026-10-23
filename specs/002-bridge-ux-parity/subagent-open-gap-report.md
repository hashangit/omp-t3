# Gap Report: Click-to-Open Subagent Sessions over the Pi Provider Bridge

**Spec**: [spec.md](./spec.md) US1 / FR9 · **Date**: 2026-10-23 · **Verdict**: UNSUPPORTED bridge-side — requires an upstream T3 Code change
**Scope rule applied** (spec US1): no look-alike UX; honest outcome is this report plus a concrete upstream ask.

## Verdict

The T3 renderer's entire openability contract is `childThreadId !== null` on the subagent turn item. The Pi provider adapter **hardcodes `childThreadId: null`** in both emission paths and silently ignores every `partialResult.details.results[]` field it does not explicitly read. No identifier the bridge can send changes this; an omp session id or file path is not consumable by any current UI code path — the value must resolve to a **T3 thread id** in the app's thread store. The Codex provider is openable only because T3's own `CodexAdapterV2` creates and registers a real T3 child thread per subagent and stamps its id.

## Evidence (verbatim extractions, T3 0.1.2)

1. **Pi adapter drops unknown fields, hardcodes null** — `provider-pi/src/server/adapter.ts` region (embedded in `~/.t3/runtime/versions/0.1.2/t3` ≈ lines 906070–908450; extraction `33.read.log:95-190`, identical in both nightlies):
   - Fields read from `details.results[]`: `agent`, `task` (required — entry skipped without them), `step`, `finished`, `stopReason`, `exitCode`, `model`, `messages[]`. Anything else is ignored.
   - Both emissions carry the literal: `childThreadId: null` (`subagent.updated` and `turn_item.updated`).
2. **Renderer gates the button on exactly one condition** — `client/assets/_chat-BdvROAFK.js:38`:
   ```js
   i.type===`subagent` && i.childThreadId!==null
     ? jsx(hn,{...onClick:()=>e.onOpenThread(i.childThreadId),children:`Open subagent thread`}) : null
   ```
   Corroborated by `useHandleNewThread-CR1xB7GE.js:11`, `entities-DEASFTd6.js` (thread-set/lineage), `runtime-BVExcDcv.js` (interrupt path). No driver check, no alternate mechanism.
3. **Codex gets openability from T3-side thread mirroring** — `CodexAdapterV2.ts` region (`t3:raw:862700-862900`, `:864300-864700`): per-subagent T3 child thread (`subagent.childThread`/`childThreadId`), registered via `registerSubagentThreads`/`registerSubagentActivity`/`rememberSubagentTurnStarted`, stamped into emitted records (`childThreadId: task.childThreadId`).
4. **omp cannot supply a T3 thread id** — pinned frame contract (`specs/001-omp-t3-translator/contracts/rpc-contract.md:42-43`): `subagent_lifecycle`/`subagent_progress`/`subagent_event` carry no session identity; a live capture of omp's task-tool progress item enumerates `{index, id, agent, agentSource, modelRole, status, task, assignment, recentTools, recentOutput, toolCount, requests, tokens, cost, durationMs}` — zero identity fields.
5. **On-disk identity exists but is unreachable** — child transcripts `<parent-dir>/<job>.jsonl` headers carry `id` + `parentSession`; even if the bridge injected them into `results[]`, the Pi adapter drops unknown fields and keeps `childThreadId: null`.

## Upstream change request (to T3 Code)

In `provider-pi/src/server/adapter.ts`, `emitSubagentTasks`:
1. Read an optional child-session reference from `details.results[]` entries (proposed: `sessionPath`, omp's child-transcript path; or `sessionId`, its uuid — omp can populate either; the on-disk format already carries both).
2. Mirror `CodexAdapterV2`'s mechanism: create/register a T3 child thread per referenced session and emit its id in `subagent.updated`/`turn_item.updated` in place of the hardcoded `childThreadId: null`.

Until that lands, click-to-open over the Pi bridge is impossible without faking it; this bridge ships no look-alike (a dead or wrong-target button is worse than none).

## Bridge-side disposition for this round

- Ship **no** user-facing change for US1 (FR9 gap-report path). `src/subagent.js` already projects every field the surface supports and stays pinned by `test/subagent.test.js`.
- Guard-rail preserved: existing subagent progress rendering MUST NOT regress (spec US1 conditional scope).
- Revisit trigger: when T3 implements the upstream ask (adapter reads a results[] session reference), a follow-up bridge iteration populates that field from omp child-transcript identity (obtainable from child transcript headers or upstream omp frame extension). Wire-field name intentionally NOT pre-shipped — an unagreed field is dead weight today and a fork risk tomorrow (Zero-Fork Principle).
