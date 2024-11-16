# API-Model Limiter

A flexible and robust rate limiter implementation using Redis for managing API keys and model access with multiple time windows.

## Core Concepts

### Rate Limiting Windows
Rate limits are tracked across different time windows (minute, hour, day, month). Each window operates independently, meaning a request must satisfy ALL window constraints to be allowed.

Example:
```javascript
{
    minute: 44,    // 44 requests per minute
    hour: 442,     // 442 requests per hour
    day: 2000      // 2000 requests per day
}
```

### Limit Borrowing
Limit borrowing allows exceeding shorter time window limits by "borrowing" from longer windows. This is useful for handling burst traffic while maintaining overall usage constraints.

**Example Use Case:**
Consider an API with limits:
- 10 requests/minute
- 50 requests/hour
- 1000 requests/day

Without borrowing:
```javascript
// If you've used 10 requests in the current minute
result = await limiter.getModel("api 1", false); // Returns null
```

With borrowing:
```javascript
// Even if minute limit (10) is reached, but hour limit has space
result = await limiter.getModel("api 1", true); // Returns valid combination
```

**When to Use Borrowing:**
- Handling burst traffic (e.g., batch processing)
- Managing irregular usage patterns
- Processing time-sensitive operations
- Providing flexibility for premium customers

### Key-Model Rotation
The system automatically rotates through available API keys and models when limits are reached. This helps maximize availability and distribute load.

**Use Case:**
```javascript
const config = [
    {
        name: "api 1",
        keys: ["key1", "key2"],     // Multiple keys
        models: [
            {
                name: "model1",      // Multiple models
                limits: {...}
            },
            {
                name: "model2",
                limits: {...}
            }
        ]
    }
];
```

## Selection Strategies

The rate limiter supports different strategies for selecting both keys and models. These strategies can be configured independently:

### Available Strategies

1. **Ascending** (default)
   - Uses keys/models in the order they are defined
   - Predictable, sequential access pattern
   - Best for simple use cases

2. **Random**
   - Randomly selects keys/models
   - Good for load balancing
   - Prevents predictable patterns

3. **Round-Robin**
   - Rotates through keys/models sequentially
   - Ensures even distribution
   - Maintains selection state between calls

### Configuration

Set strategies during initialization:
```javascript
const limiter = new RateLimiter(config, {
    keyStrategy: 'round-robin',    // Strategy for key selection
    modelStrategy: 'random',       // Strategy for model selection
    redis: { /* redis options */ },
    // ... other options
});
```

Change strategies at runtime:
```javascript
// Change key selection strategy
limiter.setKeyStrategy('random');

// Change model selection strategy
limiter.setModelStrategy('round-robin');
```

### Use Cases

1. **Ascending Strategy**
   ```javascript
   // Keys/models used in defined order
   const limiter = new RateLimiter(config, {
       keyStrategy: 'ascending',
       modelStrategy: 'ascending'
   });
   ```
   Best for:
   - Prioritized keys/models (most important first)
   - Simple, predictable behavior
   - Sequential access patterns

2. **Random Strategy**
   ```javascript
   const limiter = new RateLimiter(config, {
       keyStrategy: 'random',
       modelStrategy: 'random'
   });
   ```
   Best for:
   - Load balancing across keys
   - Avoiding predictable patterns
   - Distributing usage randomly

3. **Round-Robin Strategy**
   ```javascript
   const limiter = new RateLimiter(config, {
       keyStrategy: 'round-robin',
       modelStrategy: 'round-robin'
   });
   ```
   Best for:
   - Even distribution of usage
   - Fair allocation of resources
   - Predictable rotation patterns

## Installation

```bash
npm install ioredis
```

## Configuration Options

### RateLimiter Constructor Options

```javascript
const limiter = new RateLimiter(config, {
    redis: {
        host: 'localhost',
        port: 6379,
        password: 'optional',
        db: 0,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => Math.min(times * 50, 2000),
        enableOfflineQueue: true,
        connectTimeout: 10000
    },
    enableMetrics: true,
    batchSize: 5,
    customWindows: {
        shift: 28800,
        week: 604800
    },
    keyStrategy: 'ascending',
    modelStrategy: 'round-robin'
});
```

### Core Configuration (Required)

The first parameter (`config`) defines your APIs, keys, and models:

```javascript
const config = [
    {
        name: "api 1",          // Unique API identifier
        keys: ["key1", "key2"], // Array of API keys
        models: [               // Array of models
            {
                name: "model1", // Unique model identifier
                limits: {       // Rate limits per window
                    minute: 44,
                    hour: 442,
                    day: 2000,
                    month: 200000
                }
            }
        ]
    }
    // ... more APIs
];
```

### Redis Options
Control your Redis connection settings:

```javascript
{
    redis: {
        // Connection
        host: 'localhost',          // Redis host (default: 'localhost')
        port: 6379,                 // Redis port (default: 6379)
        password: 'secret',         // Redis password (optional)
        db: 0,                      // Redis database number (default: 0)
        
        // Timeouts
        connectTimeout: 10000,      // Connection timeout in ms (default: 10000)
        commandTimeout: 5000,       // Command execution timeout (default: 5000)
        
        // Retry Configuration
        maxRetriesPerRequest: 3,    // Max retries per command (default: 3)
        retryStrategy: (times) => { // Custom retry strategy
            return Math.min(times * 50, 2000);
        },
        
        // Advanced Options
        enableOfflineQueue: true,   // Queue commands when disconnected (default: true)
        keepAlive: 30000,          // TCP keep-alive in ms (default: 30000)
        enableAutoPipelining: true, // Enable auto pipelining (default: true)
        
        // TLS Options (if needed)
        tls: {
            // TLS configuration options
            ca: fs.readFileSync('path/to/ca.crt'),
            cert: fs.readFileSync('path/to/client.crt'),
            key: fs.readFileSync('path/to/client.key')
        }
    }
}
```

### Metrics Options
```javascript
{
    enableMetrics: true,      // Enable/disable metrics collection (default: true)
    metricsPrefix: 'custom',  // Custom prefix for metric keys (default: 'metric')
}
```

### Custom Windows Options
```javascript
{
    customWindows: {
        // Window name: duration in seconds
        halfhour: 1800,      // 30 minutes
        shift: 28800,        // 8 hours
        week: 604800,        // 1 week
        fortnight: 1209600,  // 2 weeks
        quarter: 7776000     // 3 months
    }
}
```

## API Reference

### getModel(apiName, allowBorrowing)
Get next available key:model combination for a specific API.

```javascript
// Get next available combination for "api 1"
const result = await limiter.getModel("api 1", false);
if (result) {
    console.log('Key:', result.key);
    console.log('Model:', result.model);
    console.log('Limits:', result.limits);
}
```

### getBatch(apiName, size)
Get multiple combinations for a specific API at once.

```javascript
// Get 3 combinations for "api 1"
const batch = await limiter.getBatch("api 1", 3);
if (batch) {
    batch.forEach(result => {
        console.log('Key:', result.key);
        console.log('Model:', result.model);
    });
}
```

### freezeModel(apiName, key, modelName, duration)
Freeze a specific key:model combination for an API.

```javascript
// Freeze for 5 minutes
await limiter.freezeModel("api 1", "key1", "model1", 300);
```

### updateLimits(apiName, modelName, newLimits)
Update limits for a specific model in an API.

```javascript
const newLimits = await limiter.updateLimits("api 1", "model1", {
    minute: 50,
    hour: 500
});
```

### getUsageStats(apiName, apiKey, modelName)
Get usage statistics for a specific key:model combination.

```javascript
const stats = await limiter.getUsageStats("api 1", "key1", "model1");
console.log('Current usage:', stats.currentUsage);
console.log('Metrics:', stats.metrics);
```

### getMetrics(apiName, apiKey, modelName)
Get metrics for a specific key:model combination.

```javascript
const metrics = await limiter.getMetrics("api 1", "key1", "model1");
console.log('Success rate:', metrics.success);
console.log('Limit reached count:', metrics.limitReached);
```

### Selection Strategy Methods

#### setKeyStrategy(strategy)
Change the key selection strategy.
```javascript
limiter.setKeyStrategy('random');  // 'ascending', 'random', or 'round-robin'
```

#### setModelStrategy(strategy)
Change the model selection strategy.
```javascript
limiter.setModelStrategy('round-robin');  // 'ascending', 'random', or 'round-robin'
```

## Error Handling

The rate limiter includes comprehensive error handling:

```javascript
try {
    const result = await limiter.getModel("non-existent-api");
} catch (error) {
    console.error('API not found:', error.message);
}

try {
    limiter.setKeyStrategy('invalid-strategy');
} catch (error) {
    console.error('Invalid strategy:', error.message);
}
```

## Best Practices and Recommendations

1. **Limit Borrowing Strategy**
   - Enable for premium/priority operations
   - Use with caution on public APIs
   - Consider implementing graduated borrowing limits

2. **Key-Model Rotation**
   - Distribute keys across different services/regions
   - Implement fallback models with different capabilities
   - Monitor rotation patterns for optimization

3. **Metrics Usage**
   - Set up alerts for high limit-reached rates
   - Monitor borrowed limits for capacity planning
   - Track usage patterns for optimization

4. **Error Handling**
   - Implement exponential backoff with freezing
   - Log all limit-reached events
   - Set up monitoring for frozen combinations

5. **Selection Strategy Best Practices**
   - Use 'ascending' for predictable, prioritized access
   - Use 'random' for basic load balancing
   - Use 'round-robin' for fair resource distribution
   - Monitor distribution patterns with metrics
   - Consider changing strategies based on load patterns

6. **Strategy Selection Guidelines**
   - Keys:
     - Use 'round-robin' when all keys have equal priority
     - Use 'ascending' when keys have different quotas/costs
     - Use 'random' for unpredictable load distribution
   - Models:
     - Use 'round-robin' for balanced model usage
     - Use 'ascending' for fallback patterns
     - Use 'random' for A/B testing or load balancing

## License

MIT