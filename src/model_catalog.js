'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

function modelsPersistPath() {
  const cacheDir = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(cacheDir, 'omp-t3', 'models.json');
}

class ModelCatalogManager {
  /**
   * @param {((err: Error) => void) | null} [onError] Invoked when live
   *   discovery fails and nothing (not even a persisted catalog) can serve.
   */
  constructor(onError = null) {
    this.onError = onError;
    this.cachedModels = null;
    this.lastFetchTime = 0;
    this.cacheTtlMs = 60 * 1000; // 1 minute in-memory cache
    this.servingStale = false; // true when the served list is NOT from a live discovery
  }

  /**
   * Updates the in-memory cache and persists the list to disk so a later
   * shim process can fall back to the last successfully discovered catalog.
   * @param {any[]} models
   */
  setCachedModels(models) {
    this.cachedModels = models;
    this.lastFetchTime = Date.now();
    this.servingStale = false;
    try {
      fs.mkdirSync(path.dirname(modelsPersistPath()), { recursive: true });
      fs.writeFileSync(modelsPersistPath(), JSON.stringify({ savedAt: Date.now(), models }, null, 0));
    } catch {
      // Persistence is best-effort; in-memory cache still works
    }
  }

  /**
   * Loads the last successfully discovered catalog from disk, if any.
   * @returns {{ models: any[], savedAt: number } | null}
   */
  readPersistedModels() {
    try {
      const parsed = JSON.parse(fs.readFileSync(modelsPersistPath(), 'utf8'));
      if (Array.isArray(parsed.models) && parsed.models.length > 0) {
        return { models: parsed.models, savedAt: parsed.savedAt || 0 };
      }
    } catch {
      // No persisted catalog yet
    }
    return null;
  }

  /**
   * Prunes raw OMP model list into safe, compliant ModelInfo objects.
   * Strips large schemas, pricing, and input arrays.
   * Strips redundant provider prefix from model id so T3 Code's slug builder
   * (`${provider}/${id}`) does not produce duplicate prefixes (e.g. openrouter/openrouter/...).
   * @param {any[] | { models: any[] }} rawInput 
   * @returns {any[]}
   */
  pruneModels(rawInput) {
    let list = [];
    if (Array.isArray(rawInput)) {
      list = rawInput;
    } else if (rawInput && Array.isArray(rawInput.models)) {
      list = rawInput.models;
    } else {
      return [];
    }

    return list.map((item) => {
      const provider = item.provider || 'omp';
      let id = item.id || item.selector || '';

      // If id starts with provider prefix (e.g. "openrouter/deepseek/deepseek-v4.1-flash" with provider "openrouter"),
      // strip it so T3 Code doesn't double-prefix it when building `${provider}/${id}`.
      const prefix = `${provider}/`;
      while (id.startsWith(prefix) && id.length > prefix.length) {
        id = id.slice(prefix.length);
      }

      const name = item.name || id || item.id;

      const entry = {
        id,
        name,
        provider
      };

      if (typeof item.contextWindow === 'number') {
        entry.contextWindow = item.contextWindow;
      }
      if (typeof item.maxTokens === 'number') {
        entry.maxTokens = item.maxTokens;
      }
      if (item.reasoning !== undefined) {
        entry.reasoning = Boolean(item.reasoning);
      }
      // T3 gates the per-model Thinking ladder on `reasoning: true` plus a
      // `thinkingLevelMap` ({off..max: level|null}); xhigh/max only appear if
      // mapped non-null. omp reports the supported levels as an array —
      // convert it; a boolean `thinking` field is ignored by T3.
      const levels = Array.isArray(item.thinking) ? item.thinking : null;
      if (levels) {
        const map = {};
        for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
          map[level] = levels.includes(level) ? level : null;
        }
        entry.thinkingLevelMap = map;
      } else if (item.thinking === true) {
        entry.thinkingLevelMap = { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high' };
      }

      return entry;
    });
  }

  /**
   * Fetches models directly via CLI command `omp models --json`.
   * @param {string} [ompPath] 
   * @returns {any[]}
   */
  getModels(ompPath = 'omp') {
    const now = Date.now();
    if (this.cachedModels && (now - this.lastFetchTime < this.cacheTtlMs)) {
      return this.cachedModels;
    }

    try {
      const output = execSync(`"${ompPath}" models --json`, {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 8000,
        stdio: ['pipe', 'pipe', 'ignore']
      });

      const parsed = JSON.parse(output);
      const pruned = this.pruneModels(parsed);
      if (pruned.length === 0) {
        throw new Error('omp models --json returned no models');
      }
      this.setCachedModels(pruned);
      return this.cachedModels;
    } catch (err) {
      if (this.cachedModels) {
        this.warnStale(`in-memory cached catalog (last live discovery ${new Date(this.lastFetchTime).toISOString()})`);
        return this.cachedModels;
      }

      const persisted = this.readPersistedModels();
      if (persisted) {
        this.cachedModels = persisted.models;
        this.lastFetchTime = persisted.savedAt || 0;
        this.warnStale(`persisted catalog from ${new Date(persisted.savedAt).toISOString()} (${modelsPersistPath()})`);
        return this.cachedModels;
      }

      if (typeof this.onError === 'function') {
        try {
          this.onError(err);
        } catch {
          // Never let diagnostics break discovery
        }
      }
      this.servingStale = true;
      process.stderr.write(
        `omp-t3: live model discovery failed (${err && err.message ? err.message : err}) and no previously ` +
        'discovered catalog exists; serving a minimal builtin fallback list that may be outdated.\n'
      );
      // Absolute last resort: builtin minimal models
      const defaultLadder = { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high' };
      return [
        { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', provider: 'zai', reasoning: true, thinkingLevelMap: defaultLadder },
        { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', provider: 'anthropic', reasoning: true, thinkingLevelMap: defaultLadder }
      ];
    }
  }

  /**
   * One-line stderr notice that the served catalog was not freshly discovered.
   * The doctor's contract-drift report covers the underlying failure; this
   * tells the user the list they are looking at is stale.
   * @param {string} source Description of the stale source
   */
  warnStale(source) {
    if (this.servingStale) return; // warn once per fallback episode
    this.servingStale = true;
    process.stderr.write(
      `omp-t3: live model discovery failed; serving ${source}. ` +
      'Model list may be outdated — refresh will retry on the next request.\n'
    );
  }

  /**
   * Pre-warms the catalog cache WITHOUT blocking the caller (spawnAndProxy
   * must not stall the pipeline behind a synchronous CLI invocation).
   * @param {string} ompPath
   */
  prewarm(ompPath = 'omp') {
    const { execFile } = require('node:child_process');
    execFile(ompPath, ['models', '--json'], { maxBuffer: 10 * 1024 * 1024, timeout: 10000 }, (err, stdout) => {
      if (err || this.cachedModels) return;
      try {
        const parsed = JSON.parse(stdout);
        const pruned = this.pruneModels(parsed);
        if (pruned.length > 0) {
          this.setCachedModels(pruned); // also persists to disk
        }
      } catch {
        // Keep whatever cache exists; discovery will retry on demand
      }
    });
  }

  /**
   * Synthesizes a valid T3 Code ModelInfo RPC response.
   * Includes both data: { models } and models for maximum compatibility.
   * @param {string | number} reqId 
   * @param {string} [ompPath]
   * @returns {string} Stringified JSON response with newline
   */
  createModelResponse(reqId, ompPath = 'omp') {
    const models = this.cachedModels || this.getModels(ompPath);
    const payload = {
      id: String(reqId),
      type: 'response',
      command: 'get_available_models',
      success: true,
      stale: this.servingStale || undefined, // present only when list is not freshly discovered
      data: {
        models
      },
      models
    };
    return JSON.stringify(payload) + '\n';
  }

  /**
   * Intercepts upstream get_available_models request from T3 Code.
   * @param {string} line 
   * @param {string} [ompPath]
   * @returns {{ intercepted: boolean, response?: string }}
   */
  handleUpstreamFrame(line, ompPath = 'omp') {
    if (line.includes('"type":"get_available_models"') || line.includes('"type": "get_available_models"')) {
      let reqId = null;
      try {
        const parsed = JSON.parse(line);
        reqId = parsed.id;
      } catch {
        // Fallback regex match for id
        const m = line.match(/"id"\s*:\s*("([^"]+)"|(\d+))/);
        if (m) {
          reqId = m[2] !== undefined ? m[2] : Number(m[3]);
        }
      }

      return {
        intercepted: true,
        response: this.createModelResponse(reqId || '1', ompPath)
      };
    }

    return { intercepted: false };
  }
}

module.exports = {
  ModelCatalogManager
};
