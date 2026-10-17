# Data Model & Protocol Entities

**Feature**: `001-omp-t3-translator`  
**Status**: Completed & Verified  
**Created**: 2026-10-17  

---

## 1. Core State Entities

### 1.1 Translator Session State (`TranslatorState`)
Tracks internal state of the proxy during a running conversation session.

```typescript
interface TranslatorState {
  // Last observed prompt execution status from OMP
  lastPromptStatus: 'completed' | 'aborted' | 'error' | null;
  
  // Pending request ID for active get_available_models query
  pendingModelRequestId: string | number | null;
  
  // Cached ModelInfo catalog
  cachedModels: ModelInfo[] | null;
  lastModelCacheTime: number;
  
  // Subprocess handle
  childPid: number | null;
  childExited: boolean;
  exitCode: number | null;

  // Subagent bridge: parentToolCallId -> (child id -> T3 results entry)
  // with accumulated assistant text for piSubagentOutput
  subagentsByCall: Map<string, Map<string, SubagentEntry>>;
  // Task tool call ids seen (tool_execution_start with toolName "task"), and
  // the most recent one. Subagent frames are re-parented to the spawning
  // task call (other tools never steal ownership — omp attributes late child
  // events to the currently-active tool, which orphaned T3 nodes); each
  // call's child map is pruned on its tool_execution_end.
  taskCalls: Set<string>;
  activeTaskCall: string | null;

  // Contract doctor (src/doctor.js)
  subagentSubscriptionSent: boolean;
  settleTimer: NodeJS.Timeout | null;
  lastGood: { ompVersion: string; shimVersion: string; at: number } | null;  // persisted to
                                                                            // ~/.local/state/omp-t3/contract-state.json
  issuesFiled: Record<string, number>;  // drift signature -> last issue timestamp (24h rate limit)

  // Model catalog persistence (stale-fallback chain)
  servingStale: boolean;  // true while the served list is not from a live discovery
  // persistedModels: { savedAt: number, models: ModelInfo[] } written to
  // ~/.cache/omp-t3/models.json on every successful discovery (setCachedModels)
  // and served (with a stderr stale notice) when live discovery fails.

  // Manual compact synthesis: T3 sent {"type":"compact"} and the synthesized
  // compaction_start went downstream; cleared when omp's command:"compact"
  // response crosses downstream (compaction_end synthesized around it).
  pendingManualCompact: boolean;

  // Held auto_compaction_start line awaiting its end frame; pair is dropped
  // when the end reports skipped:true (omp method-cascade noise that T3
  // would otherwise render as "Context compaction failed").
  bufferedCompactionStart: string | null;
}
```

### 1.2 Model Info Entity (`ModelInfo`)
Represents a model in T3 Code's Pi provider format.

```typescript
interface ModelInfo {
  // Clean model identifier WITHOUT provider prefix.
  // Note: T3 Code internally creates its composite slug via `${provider}/${id}`.
  // Therefore, id must NOT contain the provider prefix (e.g. "glm-5.3-flash" for provider "zai",
  // or "deepseek/deepseek-v4.1-flash" for provider "openrouter").
  id: string;
  name: string;             // Display name, e.g. "GLM-5.3 Flash"
  provider: string;         // e.g. "zai", "anthropic", "openai", "openrouter"
  contextWindow?: number;   // e.g. 1048576
  maxTokens?: number;       // e.g. 131072
  reasoning?: boolean;      // True if model supports reasoning/thinking
  // Pi-convention thinking ladder. Built from OMP's `thinking: [levels]`
  // array. T3 ignores a boolean `thinking` field — do not emit one.
  thinkingLevelMap?: { off: 'off'|null; minimal: 'minimal'|null; low: 'low'|null;
                       medium: 'medium'|null; high: 'high'|null; xhigh: 'xhigh'|null; max: 'max'|null };
}
```

---

## 2. Protocol Frame Mapping Entities

### 2.1 Upstream Frames (T3 Code -> Translator -> OMP)

#### `prompt`
- **T3 Format**: `{"type": "prompt", "message": string, "images": any[]}`
- **Action**: Resets `state.lastPromptStatus = null`, forwards line directly.

#### `abort`
- **T3 Format**: `{"type": "abort"}`
- **Action**: Sets `state.lastPromptStatus = 'aborted'`, forwards line directly.

#### `get_available_models` (Intercepted)
- **T3 Format**: `{"type": "get_available_models", "id": string | number}`
- **Action**: Intercepted. Returns synthetic response with dual `data.models` and `models` payload:
  ```json
  {
    "id": "<id>",
    "type": "response",
    "command": "get_available_models",
    "success": true,
    "data": {
      "models": [<ModelInfo>, ...]
    },
    "models": [<ModelInfo>, ...]
  }
  ```

#### `get_commands` (Intercepted)
- **T3 Format**: `{"type": "get_commands", "id": string | number}`
- **Action**: Intercepted. Returns synthetic response with empty command list:
  ```json
  {
    "id": "<id>",
    "type": "response",
    "command": "get_commands",
    "success": true,
    "data": {
      "commands": []
    }
  }
  ```

#### `set_model` (Normalized)
- **T3 Format**: `{"type": "set_model", "provider": string, "modelId": string}`
- **Action**: Normalized. If `modelId` begins with `${provider}/` (e.g. `openrouter/deepseek/...` from legacy thread slugs), `omp-t3` strips the redundant `${provider}/` prefix so OMP resolves the model correctly:
  ```json
  {
    "type": "set_model",
    "provider": "<provider>",
    "modelId": "<cleanModelId>"
  }
  ```

#### `extension_ui_response`
- **T3 Format**: `{"type": "extension_ui_response", "id": string, "response": any}`
- **Action**: Forwards line directly to OMP stdin.

---

## 2.2 Downstream Frames (OMP -> Translator -> T3 Code)

#### `ready`
- **OMP Format**: `{"type": "ready", ...}`
- **Action**: Passthrough untouched.

#### `prompt_result` (Suppressed)
- **OMP Format**: `{"type": "prompt_result", "status": "completed" | "aborted" | "error", ...}`
- **Action**: Records `state.lastPromptStatus = frame.status`. Suppresses frame (does not emit to T3).

#### `session_settled` (Transformed to `agent_settled`)
- **OMP Format**: `{"type": "session_settled"}`
- **Synthesized Frame to T3**:
  ```json
  {
    "type": "agent_settled",
    "aborted": state.lastPromptStatus === "aborted"
  }
  ```

#### `turn_start` / `turn_end`
- **OMP Format**: `{"type": "turn_start", ...}`, `{"type": "turn_end", "usage": {...}}`
- **Action**: Passthrough untouched (preserves token metrics).

#### `message_start` / `message_update` / `message_end`
- **OMP Format**:
  - `message_update`: `{"type": "message_update", "text_delta": string}`
  - `message_update`: `{"type": "message_update", "thinking_delta": string}`
  - `message_end`: `{"type": "message_end", "message": {...}}`
- **Action**: Byte-preserving passthrough untouched.

#### `extension_ui_request`
- **OMP Format**: `{"type": "extension_ui_request", "id": string, "dialog": {...}}`
- **Action**: Passthrough untouched to T3 Code.

#### `subagent_lifecycle` / `subagent_progress` / `subagent_event`
- **OMP Format** (gated by upstream `set_subagent_subscription {level:"events"}`, sent once after the child `ready` frame):
  - `{"type": "subagent_lifecycle", "payload": {"id", "agent", "parentToolCallId", "status": "started|completed|aborted", "index"}}`
  - `{"type": "subagent_progress", "payload": {"index", "agent", "task", "parentToolCallId", "progress": {"id", "status", "task", "recentOutput", "resolvedModelIdentity", ...}}}`
  - `{"type": "subagent_event", "payload": {"id", "parentToolCallId", "event": {"type": "message_end|tool_execution_start|agent_end|...", "message": {...}}}}`
- **Action**: Consumed, never forwarded raw (T3's adapter ignores unknown event types). Synthesizes `{"type":"tool_execution_update","toolCallId":<parentToolCallId>,"toolName":"subagent","partialResult":{"content":[],"details":{"results":[entries]}}}` where each entry carries `agent`, `task`, `step`, `finished`, optional `stopReason`/`exitCode`/`model`/`messages` — exactly the fields T3's `emitSubagentTasks` and `piSubagentOutput` read to render live subagent cards.
- **Superseded**: the original `task:subagent:event -> subagent_event` rename rule was dead code — OMP has never emitted that frame type. Removed.
