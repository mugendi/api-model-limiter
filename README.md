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
    await Promise.all(batch.map(combination => 
        processTask(combination)
    ));
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
    if (error.status === 429) { // Too Many Requests
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
    hour: 300
};

const offPeakLimits = {
    minute: 60,
    hour: 600
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
        week: 604800,    // Weekly limits for compliance
        fortnight: 1209600 // Bi-weekly reporting periods
    }
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
        name: "api 1",
        keys: ["key1", "key2"],
        models: [
            {
                name: "model1",
                limits: {
                    minute: 44,
                    hour: 442,
                    day: 2000
                }
            }
        ]
    }
];

const limiter = new RateLimiter(config, {
    redis: { host: 'localhost', port: 6379 },
    enableMetrics: true
});
```

### Advanced Setup with All Features
```javascript
const config = [/* ... */];

const limiter = new RateLimiter(config, {
    redis: {
        host: 'localhost',
        port: 6379,
        maxRetriesPerRequest: 3
    },
    enableMetrics: true,
    batchSize: 5,
    customWindows: {
        shift: 28800,
        week: 604800
    }
});
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

## License

MIT