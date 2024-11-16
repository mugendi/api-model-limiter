import Redis from 'ioredis';

class RateLimiter {
  constructor(config, options = {}) {
    this.redis = new Redis(options.redis);
    this.apis = config;
    this.defaultBatchSize = options.batchSize || 3;
    this.metricsEnabled = options.enableMetrics !== false;
    this.customWindows = {
      minute: 60,
      hour: 3600,
      day: 86400,
      month: 2592000,
      ...options.customWindows,
    };

    // Selection strategies
    this.keyStrategy = options.keyStrategy || 'ascending';
    this.modelStrategy = options.modelStrategy || 'ascending';

    // For round-robin tracking
    this.lastKeyIndices = {};
    this.lastModelIndices = {};

    // Validate strategies
    const validStrategies = ['ascending', 'random', 'round-robin'];
    if (!validStrategies.includes(this.keyStrategy)) {
      throw new Error(`Invalid key strategy: ${this.keyStrategy}`);
    }
    if (!validStrategies.includes(this.modelStrategy)) {
      throw new Error(`Invalid model strategy: ${this.modelStrategy}`);
    }
  }

  /**
   * Changes the key selection strategy
   */
  setKeyStrategy(strategy) {
    const validStrategies = ['ascending', 'random', 'round-robin'];
    if (!validStrategies.includes(strategy)) {
      throw new Error(`Invalid key strategy: ${strategy}`);
    }
    this.keyStrategy = strategy;
  }

  /**
   * Changes the model selection strategy
   */
  setModelStrategy(strategy) {
    const validStrategies = ['ascending', 'random', 'round-robin'];
    if (!validStrategies.includes(strategy)) {
      throw new Error(`Invalid model strategy: ${strategy}`);
    }
    this.modelStrategy = strategy;
  }

  /**
   * Gets the next round-robin index
   */
  getNextRoundRobinIndex(currentIndex, length) {
    return (currentIndex + 1) % length;
  }

  /**
   * Gets a random index
   */
  getRandomIndex(length) {
    return Math.floor(Math.random() * length);
  }

  /**
   * Gets ordered items based on strategy
   */
  getOrderedItems(items, apiName, type) {
    const strategy = type === 'key' ? this.keyStrategy : this.modelStrategy;
    const indices =
      type === 'key' ? this.lastKeyIndices : this.lastModelIndices;

    switch (strategy) {
      case 'ascending':
        return [...items];

      case 'random':
        const shuffled = [...items];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;

      case 'round-robin':
        const key = `${apiName}-${type}`;
        if (!(key in indices)) {
          indices[key] = -1;
        }
        indices[key] = this.getNextRoundRobinIndex(indices[key], items.length);
        const ordered = [...items];
        // Reorder array starting from last used index
        return [
          ...ordered.slice(indices[key]),
          ...ordered.slice(0, indices[key]),
        ];

      default:
        return [...items];
    }
  }

  /**
   * Gets next available key:model combination with optional borrowing
   */
  async getModel(apiName, allowBorrowing = false) {
    const api = this.findApi(apiName);

    // Get ordered models and keys based on their respective strategies
    const orderedModels = this.getOrderedItems(api.models, apiName, 'model');
    const orderedKeys = this.getOrderedItems(api.keys, apiName, 'key');

    for (const model of orderedModels) {
      for (const key of orderedKeys) {
        const result = await this.checkAndIncrement(key, model, allowBorrowing);

        if (result.isWithinLimits) {
          return {
            key,
            model: model.name,
            limits: result.usage,
            borrowed: result.borrowed,
          };
        }
      }
    }
    return null;
  }

  /**
   * Gets multiple available key:model combinations at once
   */
  async getBatch(apiName, size = this.defaultBatchSize) {
    const api = this.findApi(apiName);
    const results = [];

    // Get ordered models and keys based on their respective strategies
    const orderedModels = this.getOrderedItems(api.models, apiName, 'model');
    const orderedKeys = this.getOrderedItems(api.keys, apiName, 'key');

    for (const model of orderedModels) {
      for (const key of orderedKeys) {
        if (results.length >= size) break;

        const result = await this.checkAndIncrement(key, model);
        if (result.isWithinLimits) {
          results.push({
            key,
            model: model.name,
            limits: result.usage,
            borrowed: result.borrowed,
          });
        }
      }
    }

    return results.length > 0 ? results : null;
  }

  /**
   * Helper to find API configuration
   */
  findApi(apiName) {
    const api = this.apis.find((a) => a.name === apiName);
    if (!api) throw new Error(`API "${apiName}" not found`);
    return api;
  }

  /**
   * Creates a unique Redis key for a specific window
   */
  getKey(apiKey, modelName, window) {
    const timestamp = this.getWindowTimestamp(window);
    return `rate:${apiKey}:${modelName}:${window}:${timestamp}`;
  }

  /**
   * Gets the current timestamp for a specific window
   */
  getWindowTimestamp(window) {
    const now = Math.floor(Date.now() / 1000);
    const windowSize = this.customWindows[window];
    if (!windowSize) throw new Error(`Invalid window: ${window}`);
    return now - (now % windowSize);
  }

  /**
   * Gets remaining time in current window
   */
  getWindowExpiry(window) {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = this.getWindowTimestamp(window);
    const windowSize = this.customWindows[window];
    return windowStart + windowSize - now;
  }

  /**
   * Checks if a key:model combination is frozen
   */
  async isFrozen(apiKey, modelName) {
    const freezeKey = `freeze:${apiKey}:${modelName}`;
    const result = await this.redis.get(freezeKey);
    return result !== null;
  }

  /**
   * Checks and increments rate limits for a key:model combination
   */
  async checkAndIncrement(apiKey, model, allowBorrowing = false) {
    // Check if frozen
    if (await this.isFrozen(apiKey, model.name)) {
      return { isWithinLimits: false, usage: {} };
    }

    const pipeline = this.redis.pipeline();
    const limits = model.limits;
    const keys = {};

    // Set up all keys and initialize if needed
    for (const [window, limit] of Object.entries(limits)) {
      const key = this.getKey(apiKey, model.name, window);
      const expiry = this.getWindowExpiry(window);
      keys[window] = { key, limit, expiry };

      pipeline.incr(key);
      pipeline.expire(key, expiry);
    }

    // Execute all commands atomically
    const results = await pipeline.exec();
    const usage = {};
    let isWithinLimits = true;
    let borrowed = false;

    // Process results
    let i = 0;
    for (const [window, { key, limit, expiry }] of Object.entries(keys)) {
      const count = results[i * 2][1];

      usage[window] = {
        used: count,
        remaining: Math.max(0, limit - count),
        limit,
        reset: expiry,
      };

      if (count > limit) {
        if (allowBorrowing && window !== 'month') {
          borrowed = true;
        } else {
          isWithinLimits = false;
        }
      }

      i++;
    }

    // If we went over limit and couldn't borrow, rollback
    if (!isWithinLimits) {
      const rollback = this.redis.pipeline();
      for (const { key } of Object.values(keys)) {
        rollback.decr(key);
      }
      await rollback.exec();
    }

    return { isWithinLimits, usage, borrowed };
  }



  /**
   * Freezes a key:model combination
   */
  async freezeModel(apiName, key, modelName, duration) {
    this.findApi(apiName); // Validate API exists
    const freezeKey = `freeze:${key}:${modelName}`;
    await this.redis.set(freezeKey, '1', 'EX', duration);
  }

  /**
   * Updates rate limits for a model
   */
  async updateLimits(apiName, modelName, newLimits) {
    const api = this.findApi(apiName);

    const model = api.models.find((m) => m.name === modelName);
    if (!model)
      throw new Error(`Model ${modelName} not found in API ${apiName}`);

    // Validate new limits
    for (const [window, limit] of Object.entries(newLimits)) {
      if (!this.customWindows[window])
        throw new Error(`Invalid window: ${window}`);
      if (typeof limit !== 'number' || limit < 0)
        throw new Error(`Invalid limit for ${window}`);
    }

    model.limits = { ...model.limits, ...newLimits };
    return model.limits;
  }

  /**
   * Gets the metric key
   */
  getMetricKey(apiKey, modelName, type) {
    const day = this.getWindowTimestamp('day');
    return `metric:${apiKey}:${modelName}:${type}:${day}`;
  }

  /**
   * Updates metrics for rate limiting events
   */
  async updateMetrics(apiKey, modelName, type) {
    if (!this.metricsEnabled) return;

    const key = this.getMetricKey(apiKey, modelName, type);
    const expiry = this.getWindowExpiry('day');

    await this.redis.pipeline().incr(key).expire(key, expiry).exec();
  }

  /**
   * Gets usage metrics for a key:model combination
   */
  async getMetrics(apiName, apiKey, modelName) {
    this.findApi(apiName); // Validate API exists
    if (!this.metricsEnabled) return null;

    const types = ['success', 'limit_reached', 'borrowed'];
    const pipeline = this.redis.pipeline();

    for (const type of types) {
      pipeline.get(this.getMetricKey(apiKey, modelName, type));
    }

    const results = await pipeline.exec();
    return {
      success: parseInt(results[0][1]) || 0,
      limitReached: parseInt(results[1][1]) || 0,
      borrowed: parseInt(results[2][1]) || 0,
    };
  }

  /**
   * Gets current usage statistics
   */
  async getUsageStats(apiName, apiKey, modelName) {
    const api = this.findApi(apiName);
    const model = api.models.find((m) => m.name === modelName);
    if (!model)
      throw new Error(`Model ${modelName} not found in API ${apiName}`);

    const metrics = await this.getMetrics(apiName, apiKey, modelName);
    const pipeline = this.redis.pipeline();
    const windows = Object.keys(this.customWindows);

    // Get current usage for all windows
    for (const window of windows) {
      const key = this.getKey(apiKey, modelName, window);
      pipeline.get(key);
    }

    const results = await pipeline.exec();
    const usage = {};

    // Process usage for each window
    windows.forEach((window, i) => {
      const count = parseInt(results[i][1]) || 0;
      usage[window] = {
        used: count,
        remaining: model.limits[window]
          ? Math.max(0, model.limits[window] - count)
          : null,
        limit: model.limits[window] || null,
        reset: this.getWindowExpiry(window),
      };
    });

    return {
      currentUsage: usage,
      metrics: this.metricsEnabled ? metrics : null,
    };
  }
}

export default RateLimiter;
