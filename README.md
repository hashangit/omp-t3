<img src="assets/icon.svg" width="64" height="64" alt="omp-t3 icon">

# omp-t3

Run Oh My Pi inside T3 Code.

T3 Code includes a provider for upstream Pi. Pointing that provider directly at `omp` breaks three things:

1. Turn settlement. `omp` sends `session_settled` when code generation ends, but T3 Code waits for `agent_settled`. Turns stay stuck in an active state.
2. Tool approvals. T3 Code spawns agents with `--mode rpc`. That flag mutes interactive confirmation dialogs in `omp`, so bash and file approval prompts never appear.
3. Model discovery. `omp` lists more than 500 models across 60 providers in a single RPC response. That payload blows past the 1 MB frame limit and kills the connection.

`omp-t3` sits between T3 Code and `omp` over stdio. It translates settlement frames, enables `--mode rpc-ui`, prunes the model catalog to stay under frame limits, and forwards normal streaming traffic untouched.

---

## Installation

### With npm

Install globally using npm:

```bash
npm install -g omp-t3
```

### With Homebrew

Install from the tap:

```bash
brew tap hashangit/omp-t3
brew install omp-t3
```

You can also install directly from GitHub without tapping first:

```bash
brew install hashangit/omp-t3/omp-t3
```

### Run without installing

You can test `omp-t3` directly through npx:

```bash
npx omp-t3 --check
```

---

## Setup in T3 Code

1. Open **Settings** -> **Providers** -> **Pi**.
2. Set **Binary Path** to `omp-t3` (or the full path from `which omp-t3`).
3. Leave **Arguments** blank. `omp-t3` defaults to `--mode rpc-ui` automatically.
4. Click **Refresh** to populate your configured models.
5. Select your model and send a message.

---

## Verify your environment

Run the built-in diagnostic check:

```bash
omp-t3 --check
```

The check verifies that:
- The `omp` binary exists in your `$PATH` and responds to CLI queries.
- Model discovery runs and produces a payload well below the 1 MB transport ceiling.
- The session directory link between `~/.pi/agent/sessions` and `~/.omp/agent/sessions` is active, allowing T3 Code's usage view to read historical token metrics.

---

## How it works

```text
+---------------------------------------------+
|                   T3 Code                   |
|  (packages/provider-pi/src/server/adapter)  |
+---------------------------------------------+
                      ^
                      | stdio (JSONL lines)
                      v
+---------------------------------------------+
|                   omp-t3                    |
|  - Rewrites --mode rpc to --mode rpc-ui     |
|  - Translates session_settled to            |
|    agent_settled                            |
|  - Intercepts get_available_models and      |
|    prunes heavy schemas                     |
|  - Answers get_commands discovery probes    |
|  - Strips duplicate provider slugs          |
|  - Passes diffs, tokens, and bash logs      |
|    through as raw bytes                     |
+---------------------------------------------+
                      ^
                      | stdio (JSONL lines)
                      v
+---------------------------------------------+
|                     omp                     |
|               (local binary)                |
+---------------------------------------------+
```

### Protocol translation

- **CLI rewrite:** Converts incoming `--mode rpc` to `--mode rpc-ui` so `omp` emits permission requests instead of suppressing them.
- **Settlement mapping:** Captures `prompt_result` status, catches `session_settled`, and emits `agent_settled` with the right `aborted` boolean so T3 Code marks the turn complete.
- **Model catalog pruning:** Queries `omp models --json`, drops pricing arrays and verbose schemas, and returns clean entries with both `data.models` and top-level `models`.
- **Slug normalization:** Strips redundant provider prefixes from model IDs, preventing double-slug lookups like `openrouter/openrouter/...` during model selection.
- **Byte passthrough:** Everything else (token streaming deltas, diff streams, approvals, and terminal signals) passes through without JSON parsing overhead.

---

## Development

Run unit and integration tests:

```bash
npm test
```

---

## License

MIT
