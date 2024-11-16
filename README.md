<!--
 Copyright (c) 2024 Anthony Mugendi

 This software is released under the MIT License.
 https://opensource.org/licenses/MIT
-->

# API-MODEL Rate Limiter

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
result = await limiter.getModel(false); // Returns null
```

With borrowing:

```javascript
// Even if minute limit (10) is reached, but hour limit has space
result = await limiter.getModel(true); // Returns valid combination
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
    name: 'api 1',
    keys: ['Key 1', 'Key 2'],
    models: [
      {
        name: 'model1',
        limits: {
          minute: 44,
          hour: 442,
          day: 2000,
          month: 200000,
        },
      },
      {
        name: 'model2',
        limits: {
          minute: 44,
          hour: 442,
          day: 2000,
          month: 200000,
        },
      },
    ],
  },
];
```

When `key1:model1` reaches its limit, the system automatically tries:

1. `key2:model1`
2. `key1:model2`
3. `key2:model2`

## Features

### Batch Operations

Batch operations allow requesting multiple key:model combinations at once. This is particularly useful for parallel processing or preparing a queue of available slots.

**Use Case: Parallel Processing**

```javascript
// Get 3 available combinations for parallel tasks
const batch = await limiter.getBatch(3);
if (batch) {
  await Promise.all(batch.map((combination) => processTask(combination)));
}
```

### Usage Metrics and Statistics

Track usage patterns and limit utilization across different time windows. This helps in capacity planning and identifying usage patterns.

**Types of Metrics:**

- Success Rate: Successful requests
- Limit Reached: Failed requests due to limits
- Borrowed: Requests that used limit borrowing
- Current Usage: Active usage in each window

**Use Case: Capacity Planning**

```javascript
const stats = await limiter.getUsageStats('key1', 'model1');
// Analyze if you need to increase limits or add more keys
if (stats.metrics.limitReached > stats.metrics.success * 0.2) {
  // More than 20% of requests are hitting limits
  // Consider increasing capacity
}
```

### Freezing Capability

Temporarily disable specific key:model combinations. Useful for maintenance, error handling, or implementing backoff strategies.

**Use Cases:**

1. **Error Handling**

```javascript
try {
  await makeAPICall(key, model);
} catch (error) {
  if (error.status === 429) {
    // Too Many Requests
    // Freeze the combination for 5 minutes
    await limiter.freezeModel(key, model, 300);
  }
}
```

2. **Maintenance Windows**

```javascript
// Freeze during maintenance
await limiter.freezeModel(key, model, 3600); // 1 hour
```

### Dynamic Limit Updates

Update rate limits at runtime without restarting the service. Useful for implementing dynamic quotas or responding to load changes.

**Use Case: Time-based Limits**

```javascript
// Reduce limits during peak hours
const peakHourLimits = {
  minute: 30,
  hour: 300,
};

const offPeakLimits = {
  minute: 60,
  hour: 600,
};

// Update based on time of day
if (isPeakHour()) {
  await limiter.updateLimits('api1', 'model1', peakHourLimits);
} else {
  await limiter.updateLimits('api1', 'model1', offPeakLimits);
}
```

### Custom Windows

Define custom time windows beyond the standard minute/hour/day/month. Useful for specific business requirements or compliance needs.

**Use Cases:**

1. **Regulatory Compliance**

```javascript
const limiter = new RateLimiter(config, {
  customWindows: {
    week: 604800, // Weekly limits for compliance
    fortnight: 1209600, // Bi-weekly reporting periods
  },
});
```

2. **Business-specific Windows**

```javascript
{
    customWindows: {
        shift: 28800,     // 8-hour work shift
        sprint: 1209600   // 2-week sprint
    }
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

## Configuration Examples

### Basic Setup

```javascript
const config = [
  {
    name: 'api 1',
    keys: ['key1', 'key2'],
    models: [
      {
        name: 'model1',
        limits: {
          minute: 44,
          hour: 442,
          day: 2000,
        },
      },
    ],
  },
];

const limiter = new RateLimiter(config, {
  redis: { host: 'localhost', port: 6379 },
  enableMetrics: true,
});
```

### Advanced Setup with All Features

```javascript
const config = [
  /* ... */
];

const limiter = new RateLimiter(config, {
  redis: {
    host: 'localhost',
    port: 6379,
    maxRetriesPerRequest: 3,
  },
  enableMetrics: true,
  batchSize: 5,
  customWindows: {
    shift: 28800,
    week: 604800,
  },
});
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
    }
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

### Options Object (Optional)

#### Redis Options
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

#### Metrics Options
Control metrics collection and behavior:

```javascript
{
    enableMetrics: true,      // Enable/disable metrics collection (default: true)
    metricsPrefix: 'custom',  // Custom prefix for metric keys (default: 'metric')
}
```

#### Batch Operation Options
Configure batch operation behavior:

```javascript
{
    batchSize: 5,            // Default batch size for getBatch() (default: 3)
    maxBatchSize: 10,        // Maximum allowed batch size (default: 10)
    batchTimeout: 1000,      // Timeout for batch operations in ms (default: 1000)
}
```

#### Custom Windows Options
Define custom time windows beyond the defaults:

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

### Complete Configuration Example

```javascript
const config = [
    {
        name: "api 1",
        keys: ["key1", "key2"],
        models: [
            {
                name: "model1",
                limits: {
                    minute: 44,
                    hour: 442,
                    day: 2000,
                    month: 200000,
                    // Custom windows can be used in limits
                    shift: 1000,
                    week: 5000
                }
            }
        ]
    }
];

const limiter = new RateLimiter(config, {
    redis: {
        host: 'redis.example.com',
        port: 6379,
        password: 'secret',
        db: 0,
        maxRetriesPerRequest: 3,
        connectTimeout: 10000,
        commandTimeout: 5000,
        enableOfflineQueue: true,
        keepAlive: 30000,
        enableAutoPipelining: true,
        retryStrategy: (times) => Math.min(times * 50, 2000)
    },
    enableMetrics: true,
    metricsPrefix: 'myapp',
    batchSize: 5,
    maxBatchSize: 10,
    batchTimeout: 1000,
    customWindows: {
        halfhour: 1800,
        shift: 28800,
        week: 604800
    }
});
```

### Option Validation Rules

1. **API Configuration**
   - API names must be unique
   - Each API must have at least one key
   - Each API must have at least one model
   - Model names must be unique within an API
   - Limits must be positive integers

2. **Redis Options**
   - Host must be a valid hostname or IP
   - Port must be between 0 and 65535
   - Timeouts must be positive integers
   - Retry values must be reasonable (to prevent excessive retries)

3. **Custom Windows**
   - Window durations must be positive integers
   - Window names must be unique
   - Window durations must be at least 60 seconds
   - Window names cannot conflict with built-in windows

4. **Batch Operations**
   - Batch size must be between 1 and maxBatchSize
   - Batch timeout must be positive integer

### Dynamic Configuration Updates

Some options can be updated at runtime:

```javascript
// Update Redis configuration
await limiter.updateRedisConfig({
    commandTimeout: 3000
});

// Update rate limits
await limiter.updateLimits('api 1', 'model1', {
    minute: 50,
    hour: 500
});

// Update batch size
limiter.setBatchSize(8);
```

## Error Handling

```javascript
try {
  const result = await limiter.getModel(true);
  if (!result) {
    // All combinations are at limit
    handleNoAvailability();
  } else if (result.borrowed) {
    // Using borrowed limits
    logBorrowedUsage(result);
  }
} catch (error) {
  // Handle Redis or other errors
  handleError(error);
}
```

### Error Handling for Options

The RateLimiter constructor will throw errors for invalid configurations:

```javascript
try {
    const limiter = new RateLimiter(config, options);
} catch (error) {
    if (error.code === 'INVALID_CONFIG') {
        // Handle configuration errors
        console.error('Configuration error:', error.message);
    } else if (error.code === 'REDIS_ERROR') {
        // Handle Redis connection errors
        console.error('Redis error:', error.message);
    }
}
```

## License

MIT
