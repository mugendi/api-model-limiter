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
  }

  /**
   * Creates a unique Redis key for a specific window
   */
  getKey(apiKey, modelName, window) {
    const timestamp = this.getWindowTimestamp(window);
    return `rate:${apiKey}:${modelName}:${window}:${timestamp}`;
  }

  /**
   * Gets metric key
   */
  getMetricKey(apiKey, modelName, metricType) {
    const day = this.getWindowTimestamp('day');
    return `metric:${apiKey}:${modelName}:${metricType}:${day}`;
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
  async getMetrics(apiKey, modelName) {
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
   * Checks and increments rate limits with borrowing option
   */
  async checkAndIncrement(apiKey, model, allowBorrowing = false) {
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
      await this.updateMetrics(apiKey, model.name, 'limit_reached');
    } else {
      await this.updateMetrics(
        apiKey,
        model.name,
        borrowed ? 'borrowed' : 'success'
      );
    }

    return { isWithinLimits, usage, borrowed };
  }

  /**
   * Updates rate limits for a model
   */
  async updateLimits(apiName, modelName, newLimits) {
    const api = this.apis.find((a) => a.name === apiName);
    if (!api) throw new Error(`API ${apiName} not found`);

    const model = api.models.find((m) => m.name === modelName);
    if (!model) throw new Error(`Model ${modelName} not found`);

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
   * Gets multiple available key:model combinations at once
   */
  async getBatch(size = this.defaultBatchSize) {
    const results = [];

    for (const api of this.apis) {
      for (const model of api.models) {
        for (const key of api.keys) {
          if (results.length >= size) break;

          const result = await this.checkAndIncrement(key, model);
          if (result.isWithinLimits) {
            results.push({
              key,
              model: model.name,
              limits: result.usage,
            });
          }
        }
      }
    }

    return results.length > 0 ? results : null;
  }

  /**
   * Gets next available key:model combination with optional borrowing
   */
  async getModel(allowBorrowing = false) {
    for (const api of this.apis) {
      for (const model of api.models) {
        for (const key of api.keys) {
          const result = await this.checkAndIncrement(
            key,
            model,
            allowBorrowing
          );

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
    }
    return null;
  }

  /**
   * Freezes a key:model combination
   */
  async freezeModel(key, modelName, duration) {
    const freezeKey = `freeze:${key}:${modelName}`;
    await this.redis.set(freezeKey, '1', 'EX', duration);
  }

  /**
   * Gets current usage statistics
   */
  async getUsageStats(apiKey, modelName) {
    const metrics = await this.getMetrics(apiKey, modelName);
    const pipeline = this.redis.pipeline();
    const windows = Object.keys(this.customWindows);

    for (const window of windows) {
      pipeline.get(this.getKey(apiKey, modelName, window));
    }

    const results = await pipeline.exec();
    const usage = {};

    windows.forEach((window, i) => {
      usage[window] = parseInt(results[i][1]) || 0;
    });

    return {
      currentUsage: usage,
      metrics,
    };
  }
}

export default RateLimiter;
