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

```javascript
result = await limiter.getModel('api 1');
```

This returns:

```json
{
  "key": "key 1",
  "model": "model 1",
  "limits": { "minute": 13 }
}
```

When we have exhausted all model limits, then the `model` property will be null.

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

1. **Ordered** (default)

   - Uses keys/models in the order they are defined
   - Predictable, sequential access pattern
   - Best for simple use cases

2. **Random**
   - Randomly selects keys/models
   - Good for load balancing
   - Prevents predictable patterns

### Configuration

Set strategies during initialization:

```javascript
const limiter = new RateLimiter(config, {
  keyStrategy: 'round-robin', // Strategy for key selection
  modelStrategy: 'random', // Strategy for model selection
  redis: {
    /* redis options */
  },
  // ... other options
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
    connectTimeout: 10000,
  },

  customWindows: {
    shift: 28800,
    week: 604800,
  },
  keyStrategy: 'ordered',
  modelStrategy: 'random',
});
```

### Core Configuration (Required)

The first parameter (`config`) defines your APIs, keys, and models:

```javascript
const config = [
  {
    name: 'api 1', // Unique API identifier
    keys: ['key1', 'key2'], // Array of API keys
    models: [
      // Array of models
      {
        name: 'model1', // Unique model identifier
        limits: {
          // Rate limits per window
          minute: 44,
          hour: 442,
          day: 2000,
          month: 200000,
        },
      },
    ],
  },
  // ... more APIs
];
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

### getModel(apiName)

Get next available key:model combination for a specific API.

```javascript
// Get next available combination for "api 1"
const result = await limiter.getModel('api 1');
if (result) {
  console.log('Key:', result.key);
  console.log('Model:', result.model);
  console.log('Limits:', result.limits);
}
```

### freezeModel({apiName, key, model, duration})

Freeze a specific key:model combination for an API.

```javascript
// Freeze for 5 minutes
await limiter.freezeModel({
  apiName: 'api 1',
  key: 'key 1',
  model: 'model 1',
  duration: 3000,
});
```

## License

MIT
