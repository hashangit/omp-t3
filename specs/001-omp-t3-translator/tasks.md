# Implementation Tasks: OMP-to-T3 Code Translator Shim (`omp-t3`)

**Feature**: `001-omp-t3-translator`  
**Status**: Completed & Verified  
**Created**: 2026-10-17  

---

## Task List

### Phase 1: Setup & Initialization

- [X] T001 Initialize package.json with CLI metadata, binary bin entry, and test scripts in package.json
- [X] T002 Create .gitignore for Node.js project artifacts, logs, and caches in .gitignore

---

### Phase 2: Foundational Infrastructure

- [X] T003 Implement CLI argument rewriter and flags resolver in src/cli.js
- [X] T004 Implement historical session symlink manager in src/symlink.js
- [X] T005 Implement test harness and mock RPC streams runner in test/helpers.js

---

### Phase 3: User Story 1 - Turn Settlement & Execution Parity (Priority: P1)

- [X] T006 [P] [US1] Create unit tests for prompt_result suppression and session_settled translation in test/settlement.test.js
- [X] T007 [US1] Implement settlement state tracker and agent_settled frame synthesizer in src/settlement.js

---

### Phase 4: User Story 2 - Zero-Flag Transparent CLI & Process Proxy (Priority: P1)

- [X] T008 [P] [US2] Create unit tests for CLI argument rewriting, default flag injection, and signals in test/cli.test.js
- [X] T009 [US2] Implement bi-directional stdio proxy, process spawning, byte-preserving passthrough, and signal forwarding in src/proxy.js
- [X] T010 [US2] Implement primary executable CLI entry point in bin/omp-t3

---

### Phase 5: User Story 3 - Safe Dynamic Model Catalog Discovery (Priority: P1)

- [X] T011 [P] [US3] Create unit tests for get_available_models interception and schema pruning in test/model_catalog.test.js
- [X] T012 [US3] Implement dynamic model discovery via omp models --json and size-safe response generator in src/model_catalog.js

---

### Phase 6: User Story 4 - Permission & Approval Dialog Bridging (Priority: P2)

- [X] T013 [P] [US4] Create unit tests for extension_ui_request and extension_ui_response passthrough in test/approval.test.js
- [X] T014 [US4] Integrate extension UI frame forwarding and verification into src/proxy.js

---

### Phase 7: User Story 5 - Subagent Event Bridging (Priority: P2)

- [X] T015 [P] [US5] Create unit tests for task to subagent event normalization in test/subagent.test.js
- [X] T016 [US5] Implement subagent event translator in src/subagent.js and connect to proxy in src/proxy.js

---

### Phase 8: User Story 6 - Usage Metrics & Session Symlink (Priority: P3)

- [X] T017 [P] [US6] Create unit tests for turn_end token usage passthrough in test/usage.test.js
- [X] T018 [US6] Implement automatic symlink verification during proxy startup in src/proxy.js

---

### Phase 9: Polish & Cross-Cutting Concerns

- [X] T019 Implement --check health check command to verify real omp binary and model catalog in bin/omp-t3
- [X] T020 Run full test suite and verify 100% pass rate in test/
- [X] T021 Update README.md with comprehensive installation, T3 Code configuration, and architecture details in README.md

---

### Phase 10: T3 Code Live Compatibility & Bug Fixes

- [X] T022 Wrap get_available_models response with data: { models } alongside top-level models in src/model_catalog.js
- [X] T023 Implement get_commands discovery stub in src/proxy.js
- [X] T024 Fix model slug prefix duplication: strip redundant ${provider}/ in src/model_catalog.js and add defensive set_model normalizer in src/proxy.js
- [X] T025 Add regression tests for model prefix stripping and set_model forwarding in test/model_catalog.test.js and test/e2e.test.js
- [X] T026 Verify full turn execution live in T3 Code UI

---

## Dependencies & Completion Order

```text
Phase 1 (Setup)
   │
   ▼
Phase 2 (Foundational: CLI, Symlink, Test Helper)
   │
   ├──────────────────────────┐
   ▼                          ▼
Phase 3 (US1: Settlement)  Phase 5 (US3: Model Catalog)
   │                          │
   └──────────┬───────────────┘
              │
              ▼
Phase 4 (US2: Proxy & CLI Entry bin/omp-t3)
   │
   ├──────────────────────────┐
   ▼                          ▼
Phase 6 (US4: Approvals)   Phase 7 (US5: Subagents)
   │                          │
   └──────────┬───────────────┘
              │
              ▼
Phase 8 (US6: Usage & Session Symlink)
   │
   ▼
Phase 9 (Polish, Health Check, Verification, README)
   │
   ▼
Phase 10 (Live T3 Compatibility: Model Slug & Discovery Fixes)
```
