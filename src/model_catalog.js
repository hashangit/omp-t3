'use strict';

const { execSync } = require('node:child_process');

class ModelCatalogManager {
  constructor() {
    this.cachedModels = null;
    this.lastFetchTime = 0;
    this.cacheTtlMs = 60 * 1000; // 1 minute in-memory cache
  }

  setCachedModels(models) {
    this.cachedModels = models;
    this.lastFetchTime = Date.now();
  }

  /**
   * Prunes raw OMP model list into safe, compliant ModelInfo objects.
   * Strips large schemas, pricing, and input arrays.
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
      // T3 expects selector or provider/id as identifier
      const id = item.selector || (item.provider ? `${item.provider}/${item.id}` : item.id);
      const name = item.name || item.id;
      const provider = item.provider || 'omp';

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
      if (item.thinking !== undefined && item.thinking !== null) {
        entry.thinking = Array.isArray(item.thinking) ? item.thinking.length > 0 : Boolean(item.thinking);
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
      this.cachedModels = this.pruneModels(parsed);
      this.lastFetchTime = now;
      return this.cachedModels;
    } catch (err) {
      if (this.cachedModels) {
        return this.cachedModels;
      }
      // Fallback default minimal models if omp models command fails
      return [
        { id: 'zai/glm-5.3-flash', name: 'GLM 5.3 Flash', provider: 'zai', reasoning: true, thinking: true },
        { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', provider: 'anthropic', reasoning: true }
      ];
    }
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
