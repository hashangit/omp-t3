# Workflow troubleshooting

The provider launch and its review workflow must produce observable success or
failure without changing user-selected arguments or terminating other sessions.

## Requirements

- FR1: Default delegation enforcement excludes the native `task` tool. Validate
  only shim-injected tool lists. Explicit user lists in either CLI form bypass
  injection and validation.
- FR2: Recognize singular and plural unknown-tool errors and unavailable-tool
  errors. Pruning must make progress, retain at least one tool, and stop after
  at most five probes.
- FR3: Validation succeeds only after an RPC `ready` frame. A probe has a
  five-second readiness deadline. Exit zero without ready is a failure.
- FR4: Fallback retains original user prompt appendices, session arguments,
  and the optional concurrency overlay. Opt-out preserves user appendices.
- FR5: Handle spawn errors and termination signals. Cleanup targets the probe's
  recorded process or its private Unix process group, never a name pattern.
- FR6: Document defaults, opt-out, fallback behavior, probe side effects, and
  the distinction between native OMP task concurrency and T3 delegation.

## Acceptance criteria

- SC1: The full test suite and integration check pass.
- SC2: Executable launcher tests cover singular/plural rejection, late rejection,
  empty-list fallback, original user flags, early exit, spawn errors, and interrupt
  cleanup. Regression tests fail on the previous committed launcher.
- SC3: The real installed OMP answers `get_state` successfully after launching
  through the shim, with enforcement both enabled and opted out.
- SC4: Troubleshooting evidence distinguishes observed reviewer termination from
  an unproven completion-notification bug. Historical receipts are not reused as
  approval for later source commits.

Local commits and Gatekeeper Review are authorized. This work does not request a
version bump, Release gate, tag, push, publication, or changes to the reference
thread.
