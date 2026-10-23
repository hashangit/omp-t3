# Feature Specification: Bridge Hardening & UX Parity Round (`omp-t3` Round 2)

## 1.1 Summary

Both sides of the bridge moved: T3 Code shipped 0.1.2 and the coding agent moved to 18.12.x. An evidence-backed contract audit found **zero frame-shape breaks** — the bridge keeps working — but surfaced two forward-compat gaps that will break later, five user-visible experience gaps the upstream changes now make closable, and one parity feature T3 users get with every other provider but this bridge: **clicking a subagent in T3's subagent UI opens that subagent's session** (works with the Codex provider; does nothing over this bridge).

This round delivers, in one coherent release:

1. **One forward-compat fix** — the self-update command T3's provider maintenance already calls (and which currently fails). *(The session-continuation argument needs no bridge work: omp accepts `--session`/`--fork` natively — pass-through is pinned instead.)*
2. **Four integration UX improvements** — explain held-open runs, show drift in-thread, carry live subagent narration, and make first-launch discovery reliably complete within T3's discovery window.
3. **One new parity feature** — click-to-open subagent sessions in T3's UI, conditional on what the provider surface actually allows; if it does not allow it, the round ships the evidence and the exact upstream ask instead of a partial UX. *(Resolved to the gap-report path — see US1.)*
4. **Regression pins** for upstream behavioral changes (post-settle compaction events, rollback across compacted sessions, deferred extension loading) so the next upstream update cannot silently regress them.

Out of scope: any frame-shape change (audit found none needed), T3-side or coding-agent-side code changes (this round only changes the bridge), renegotiating the version scheme from feature 001, cross-session approval caching (cut in review — net-negative; see US5), and session-continuation translation (cut — verified unnecessary; see US7).

## 1.2 Separation of Concerns & Zero-Fork Principle

Unchanged from feature 001: the bridge never forks upstream behavior it can mirror; it only translates, synthesizes what the provider surface lacks, and reports what it cannot fix. Every UX improvement in this round is *additive signaling* (notices, extra entry fields) or *launch-default* (an agent-side setting the bridge may set), never a protocol fork.

---

### US1: Clickable Subagent Sessions (Priority: P1)

**As a** T3 Code user on this bridge, **when** a turn spawns subagents and I open the subagent/task view, **I want** to click a subagent entry and open that subagent's own session, **so that** I can inspect what a child agent did without leaving the app — the same way this works when T3 uses its Codex provider.

Today the entry renders but clicking does nothing over this bridge.

**Conditional scope (user directive: "if possible and if the provider allows"):**
- The round MUST first establish, from the provider's shipped adapter code, whether the surface exposes whatever makes a subagent entry openable (an identifier T3 can resolve to a child session).
- If it does: subagent entries produced by the bridge MUST carry the child-session identity so clicking behaves exactly as with the Codex provider.
- If it does not: the round MUST ship a written gap report (what field/mechanism is missing, where, with extracted evidence) and the concrete upstream change request — NOT a look-alike that opens the wrong thing or nothing.
- Either way, existing subagent progress rendering MUST NOT regress.

**Resolution (2026-10-23 research)**: the conditional resolved to the gap-report path — [subagent-open-gap-report.md](./subagent-open-gap-report.md). The renderer's entire openability contract is `childThreadId !== null`, hardcoded `null` in the Pi adapter; no bridge-sent field can change it. Upstream ask documented there.

### US2: Visible Hold-Open Reason (Priority: P1)

**As a** T3 Code user, **when** my run stays active longer than the answer took (background jobs, long-lived dev servers, detached work keeping the session open), **I want** the thread to say what is holding it open, **so that** an "active" run is explainable instead of looking stuck.

Today the run just stays active with no explanation; users cannot distinguish "still working" from "hung".

A hold-open notice MUST appear when a run is held open by pending work, state the pending subagent count when the bridge knows it authoritatively (its own live subagent entries — omp exposes background jobs only as a boolean, so there is never an invented count), and otherwise say "pending background work". It appears once per hold interval and re-emits only when the pending state's signature changes; it clears when the run settles. It MUST NOT mark the turn as finished or interfere with settlement timing.

### US3: In-Thread Drift & Settlement Visibility (Priority: P1)

**As a** T3 Code user, **when** the bridge's contract doctor synthesizes a missing settlement after a watchdog (the one intervention that happens while a run is active), **I want** the thread to say why a turn ended, **so that** I know that a safety net fired — instead of the event existing only in a log file and an automated issue.

Settlement-synthesis drift MUST render in-thread immediately before the synthesized settle (the turn is still active, so the consumer can display it — after the settle no turn exists and notices are dropped). It MUST NOT mark the turn finished and MUST NOT delay the synthesized settle. Other interventions stay as they are: discovery failures are stdout/stderr events in the open session's channels. stderr logging and rate-limited issue filing continue unchanged, and the same 24h rate-limit ledger limits in-thread notices (no notice storms).

### US4: Live Subagent Narration (Priority: P2)

**As a** T3 Code user, **when** subagents run, **I want** their task-card entries to show what each subagent is doing right now, in the subagent's own words, **so that** long child runs are interpretable without opening them.

The coding agent (18.12.3+) now reports each subagent's current step in its own words. The bridge MUST carry this narration and progress text into the subagent entries it projects, respecting the display limits the consumer renders (short progress text, bounded final result), and MUST pin the shape with a test.

### US5: Persistent Approvals (Priority: P2)

**CUT in review (2026-10-23)** — research R3 proved this needs no bridge code and that enabling it would be net-negative: omp's default approval mode is not what gates the user-visible flow, and T3's own extension hook renders the confirm dialogs. An in-thread approval confirm path for the bridge to suppress does not exist. The intended benefit (fewer repeated prompts) is unachievable bridge-side today; the upstream ask stays as filed in [research.md](./research.md) R3. (Also verified live: the ledger-backed approval state exists in agent.db, but no consumer hook consumes it for cross-session approval memory.)

### US6: Reliable First-Launch Discovery (Priority: P2)

**As a** T3 Code user, **when** I add the bridge as a provider and send my first message, **I want** the model list and command menus populated on the first try, **so that** setup never shows an empty list because discovery raced the consumer's timeout.

The consumer doubled its discovery patience (15s → 30s). The bridge's cold-start command-discovery bound (single-flight refresh) MUST use the available window to complete command discovery before answering an empty list; the short bounded fallback remains only as a last resort after the window (implemented as 2500ms → 10000ms on the refresh wait). First-discovery latency MUST stay within the consumer's window.

### US7: Session Continuity Support (Priority: P3)

**CUT in review (2026-10-23)** — verified unnecessary against omp 18.12.6: omp natively accepts `--session <path>` and `--fork <path>` launch arguments (a missing path correctly fails with `Error: Session "..." not found.`), and T3's Pi adapter launches the bridge with exactly those flags. The bridge forwards every non-`--mode` launch flag unchanged today, so the flow already works; the only bridge work is a regression pin (FR1) so no future pre-forwarding rewrite can break it. The help-text line stays as-is (it already advertises supported flags truthfully).

### US8: Self-Update Parity (Priority: P3)

**As a** T3 Code user, **when** T3 runs its provider maintenance/self-update resolver against this bridge, **I want** it to succeed or clearly no-op, **so that** T3's update flow doesn't log failures for a provider it thinks it can maintain.

Today the resolver's call fails with "unknown option". The bridge MUST accept the self-update invocation. By default it MUST be a successful, clearly explained no-op (report install channel, install path, and the exact manual update command; exit 0) — unattended global package mutation is unacceptable. A real channel update (npm / Homebrew) MUST be executable only by explicit user opt-in (`update --yes`); a git checkout install is always guidance-only. It MUST never print an unknown-option error. `omp --check` reports the detected install channel.

---

## Functional Requirements

**Forward-compat fixes**
- FR1: The consumer's session-continuation launch arguments (`--session <path>`, `--fork <path>`) pass through to the coding agent byte-identically — omp accepts them natively (verified 18.12.6); no bridge translation exists; absence preserves current behavior exactly. Pinned by a test.
- FR2: The bridge implements the consumer's self-update invocation as a successful, clearly-explained no-op by default (install channel + manual command reported; exit 0); a real package-manager update runs only on explicit `update --yes`; a git checkout is always guidance-only. It MUST never print an unknown-option error.

**UX improvements**
- FR4: When settlement is withheld because work is pending, the bridge emits a hold-open notice into the thread — stating the pending subagent count when the count is authoritative, "pending background work" otherwise — at most once per hold interval, re-emitted only when the pending signature changes; settlement timing is unaffected.
- FR5: Watchdog settlement-synthesis interventions render in-thread immediately before the synthesized settle; discovery failures stay off-thread (pre-any-turn, where the consumer renders nothing); stderr logging and rate-limited issue filing unchanged; in-thread notices respect the same rate-limit ledger.
- FR6: Subagent entries carry current-step narration (`lastIntent`, 18.12.3+) while a child runs and the final assistant text once finished, with recent output as fallback, within the consumer's display limits; the projected shape is pinned by a test.
- FR8: Cold-start command discovery completes within the consumer's discovery window before any bounded empty fallback (the single-flight refresh wait bound raised 2500ms → 10000ms); the fallback remains as last resort.

**Parity feature**
- FR9: Subagent entries carry child-session identity if and only if the provider surface defines how the consumer opens child sessions; feasibility is established from extracted adapter evidence before implementation; an unsupported surface produces a gap report artifact instead of partial behavior.

**Regression pins**
- FR10: A pinned test proves compaction events arriving after a run settled do not re-settle, re-open, or kill the run.
- FR11: A pinned test proves rollback/fork across a compacted session keeps entry history intact through the bridge.
- FR12: A verification run proves deferred extension loading does not delay the consumer's tool registration past the first message.
- FR13: The full existing test suite passes; every new projected shape or notice gains a pinning test at the moment it ships (feature 001 §7.2 rule).

## Success Criteria

- **SC1**: With the Codex provider as reference, a user can open a clicked subagent session over this bridge in the same number of interactions (zero extra steps); or, if the surface blocks it, a gap report exists that names the exact missing mechanism with extracted evidence (measurable: report names field + source location).
- **SC2**: In a scenario with a pending long-lived background job, the thread shows a hold-open notice within 2 seconds of the answer finishing — stating pending subagents when the bridge can count them authoritatively, otherwise "pending background work" — and the run still settles normally once the job drains.
- **SC3**: With settlement deliberately withheld (drift simulation), the intervention appears in-thread before the synthesized settle within the watchdog window and the automated issue is still filed at most once per signature per day.
- **SC4**: A subagent running a multi-step task shows changing step narration on its task card while running (at least one observed change mid-run).
- **SC6**: First launch with cold caches populates model list and commands on the first poll, measured within the consumer's 30s discovery window, with zero empty-first-poll occurrences across 5 consecutive cold starts.
- **SC8**: The consumer's provider-maintenance resolver runs against the bridge without an unknown-option failure (exit 0, clear manual-update guidance; a real package-manager update happens only when a user invokes `omp-t3 update --yes`).
- **SC9**: Zero regressions: full suite green before and after; every upstream behavioral pin (FR10–FR12) demonstrated passing.

## Key Entities

- **HoldOpenNotice** — authoritative subagent count (live unfinished subagent entries across open task calls) or the explicit "pending background work" fallback; lifecycle tied to the pending set (signature = `subagents:<n>` | `background`), cleared when the run settles.
- **SubagentEntry (extended)** — existing fields (agent, task, step, finished, stop reason, model, messages) plus projected narration; no child-session identity (US1 resolved to the gap report).
- **DriftNotice** — signature, side (bridge vs agent vs consumer), human-readable intervention description; shares the rate-limit ledger with issue filing; wired only to settle-synthesis (active-turn) reporting.

## Assumptions

- Baseline: T3 Code 0.1.2+ and coding agent 18.12.6+; the audited frame contract holds (no shape changes in either side's current releases).
- T3's Codex provider is the reference UX for subagent openability.
- If research shows the provider surface cannot support FR9, the conditional gap-report path of US1 satisfies this spec's intent (honest parity outcome, no fake UX).
- omp accepts `--session`/`--fork` natively (verified 18.12.6), so session continuity is pure passthrough.

## Dependencies

- Upstream: T3 0.1.2 (extended discovery window, system-notice rendering, self-update resolver call); coding agent 18.12.6 (subagent step reporting, deferred extension loading, native resume-by-path).
- Feature 001's translator architecture (settlement mirroring, subagent bridge, command catalog, doctor) — this round extends it, never replaces it.

## History

- **2026-10-23 (plan research)**: US1 conditional resolved to gap-report path (see US1 Resolution). FR7/SC5 refined from "default-on" to "runtime-mode-gated" — research R3 showed omp's approval default is `yolo` and the consumer's extension hook is the visible gate, so non-gated enablement would add prompts without cross-session benefit. Notice channel, discovery bound (10s), and deferred-loading acceptance decided in [research.md](./research.md).
- **2026-10-23 (implementation review)**: scope corrected and cut item states recorded here. US5/FR7/SC5 cut (approval machinery: net-negative, no in-thread suppress path exists; upstream ask retained). US7/SC7/FR3 cut: omp accepts `--session`/`--fork` natively (live-verified) — FR1 is now a byte-passthrough pin and the help text stands. US3 narrowed to settle-synthesis notices before the settle (the only active-turn intervention; consumer drops notices when no turn is active) with discovery failures kept off-thread. FR4 hold text corrected to honest data (no invented kind/count — omp exposes only `get_state.hasPendingAsyncWork`; subagent counts come from the bridge's own live entries). FR2 landed as no-op default + `--yes` opt-in (T3 calls `update --self` routinely from its provider maintainer; global mutation stays user-initiated). FR12's verification is a live `--check` ledger probe (agent.db `cache` table) plus quickstart steps, not a live-omp unit test.
