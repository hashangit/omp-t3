# Contract: Bidirectional JSONL RPC Protocol

**Feature**: `001-omp-t3-translator`  
**Status**: Completed & Verified  
**Created**: 2026-10-17  

---

## 1. Upstream Interceptor Matrix (T3 -> OMP)

| Match Rule | Action | Output to OMP | Output to T3 |
|---|---|---|---|
| `line` contains `"type":"get_available_models"` | Intercept | None | `{"id": id, "type": "response", "command": "get_available_models", "success": true, "data": {"models": [...]}, "models": [...]}` |
| `line` contains `"type":"get_commands"` | Intercept | None | `{"id": id, "type": "response", "command": "get_commands", "success": true, "data": {"commands": []}}` |
| `line` contains `"type":"set_model"` | Normalize | `normalized_set_model + '\n'` (redundant `${provider}/` stripped from `modelId`) | None |
| `line` contains `"type":"prompt"` | Record turn start | `line + '\n'` | None |
| `line` contains `"type":"abort"` | Set `aborted = true` | `line + '\n'` | None |
| Any other line | Byte-Preserving Passthrough | `line + '\n'` | None |

---

## 2. Downstream Interceptor Matrix (OMP -> T3)

| Match Rule | Action | Output to T3 | Output to OMP |
|---|---|---|---|
| `line` contains `"type":"session_settled"` | Intercept & Translate | `{"type": "agent_settled", "aborted": <aborted_status>} + '\n'` | None |
| `line` contains `"type":"prompt_result"` | Intercept & Suppress | None (record `status`) | None |
| `line` contains `"type":"subagent_event"` or `"type":"task:subagent:event"` | Intercept & Normalize | `normalized_subagent_event + '\n'` | None |
| `line` contains `"type":"advisor_cost_changed"` | Suppress | None | None |
| Any other line (`message_update`, `tool_execution_*`, `ready`, `turn_end`, etc.) | Byte-Preserving Passthrough | `line + '\n'` | None |

---

## 3. Byte-Preserving Passthrough Contract

For maximum performance and zero risk of JSON formatting regressions:
1. Lines that do not trigger interceptor conditions MUST NOT be passed through `JSON.parse` or `JSON.stringify`.
2. The raw string or Buffer chunk with newline MUST be piped directly to the corresponding destination stream.
