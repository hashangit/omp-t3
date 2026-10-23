'use strict';

/**
 * In-thread notice frames (feature 002 round 2: hold-open reason FR4,
 * drift visibility FR5).
 *
 * Channel (verified against T3 0.1.2's bundled Pi adapter): an
 * `extension_ui_request` frame with `method: "notify"` is projected by the
 * adapter into a `system_notice` thread item — the same frame omp's own
 * extension `ctx.ui.notify` emits. Two hard consumer rules shape this module:
 *
 * 1. The adapter drops the notify when no provider turn is active, so notices
 *    are only meaningful mid-run. Drift notices that explain a synthesized
 *    settle MUST be written immediately BEFORE that settle; a hold-open
 *    notice is emitted while the run is being held open by definition.
 * 2. Notices carry no settlement semantics. They never synthesize or delay
 *    `agent_settled`; settlement.js remains the single settle point.
 */

/**
 * Builds one notify frame. `id` is not consumed by T3's notify path but is
 * included for symmetry with omp's own notify frames and for log correlation.
 * @param {number} counter Monotonic per-process counter (1-based)
 * @param {string} message Human-readable notice text (never empty: the
 *   consumer rejects empty notify messages)
 * @returns {string} JSON line including trailing newline
 */
function notifyFrame(counter, message) {
  return JSON.stringify({
    type: 'extension_ui_request',
    id: `ompt3-notice-${counter}`,
    method: 'notify',
    message,
    notifyType: 'info'
  }) + '\n';
}

/**
 * Hold-open text. The bridge can count only its own live subagents; omp
 * exposes background job state as a boolean (`get_state.hasPendingAsyncWork`),
 * never as counts or kinds. A count is stated only when it is authoritative —
 * never invented.
 * @param {{ pendingSubagents?: number|null, countAuthoritative: boolean }} info
 * @returns {string}
 */
function holdOpenText(info) {
  if (info && info.countAuthoritative && info.pendingSubagents > 0) {
    return `Run held open: ${info.pendingSubagents} pending subagent${info.pendingSubagents === 1 ? '' : 's'}`;
  }
  return 'Run held open: pending background work';
}

/**
 * Emits at most one hold-open notice per hold interval, re-emitting only when
 * the pending signature (`subagents:<n>` | `background`) changes. The
 * signature resets when the run settles, so the next hold interval starts
 * fresh.
 */
class HoldOpenTracker {
  /**
   * @param {(line: string) => void} emit Writes the frame to the consumer.
   * @param {object} [options]
   */
  constructor(emit, options = {}) {
    this.emit = emit;
    this.counter = options.counter ?? 0;
    this.lastSignature = null;
  }

  /**
   * Observes one "settlement withheld / async work pending" signal.
   * @param {{ pendingSubagents?: number|null, countAuthoritative: boolean }} [info]
   * @returns {boolean} true when a notice was emitted
   */
  tick(info) {
    const signature = info && info.countAuthoritative && info.pendingSubagents > 0
      ? `subagents:${info.pendingSubagents}`
      : 'background';
    if (signature === this.lastSignature) return false;
    this.lastSignature = signature;
    this.counter += 1;
    this.emit(notifyFrame(this.counter, holdOpenText(info)));
    return true;
  }

  /** Clears hold state when the run settles; the next hold emits again. */
  clear() {
    this.lastSignature = null;
  }
}

module.exports = {
  HoldOpenTracker,
  holdOpenText,
  notifyFrame
};
