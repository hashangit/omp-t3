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
  thinking?: boolean;       // Alias for reasoning support
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

#### `task:subagent:event` / `subagent_event`
- **OMP Format**: `{"type": "task:subagent:event", ...}`
- **Action**: Transformed to T3's subagent event structure.
