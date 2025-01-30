import Redis from 'ioredis';
import Validator from 'fastest-validator';
const v = new Validator();

const configSchema = {
  $$root: true,
  type: 'array',
  items: {
    type: 'object',
    props: {
      name: 'string',
      keys: {
        type: 'array',
        items: 'string',
      },
      models: {
        type: 'array',
        items: 'array',
        items: {
          type: 'object',
          props: {
            name: 'string',
            limits: {
              type: 'object',
              minProps: 1,
              props: {
                minute: 'number|optional',
                day: 'number|optional',
                month: 'number|optional',
              },
            },
          },
        },
      },
    },
  },
};

const optsSchema = {
  $$root: true,
  type: 'object',
  optional: true,
  default: {},
  props: {
    customWindows: 'object|optional',
    keyPrefix: 'string|optional',
    redis: 'object|optional',
    modelStrategy: {
      type: 'string',
      optional: true,
      enum: ['ordered', 'random'],
    },
  },
};

const freezeOptsSchema = {
  apiName: 'string',
  key: 'string',
  model: 'string',
  duration: 'number',
};

class RateLimiter {
  constructor(config, options = {}) {
    config = arrify(config);

    // validate schema
    validate(configSchema, config);
    validate(optsSchema, options);

    this.redis = new Redis(options.redis);
    this.apis = arrify(config);
    this.customWindows = {
      minute: 60,
      hour: 3600,
      day: 86400,
      month: 2592000,
      ...options.customWindows,
    };

    this.keyPrefix = options.keyPrefix || 'ModelLimiter';

    // Selection strategies
    this.keyStrategy = options.keyStrategy || 'ordered';
    this.modelStrategy = options.modelStrategy || 'ordered';

    // Validate strategies
    const validStrategies = ['ordered', 'random'];

    if (!validStrategies.includes(this.keyStrategy)) {
      throw new Error(`Invalid key strategy: ${this.keyStrategy}`);
    }
    if (!validStrategies.includes(this.modelStrategy)) {
      throw new Error(`Invalid model strategy: ${this.modelStrategy}`);
    }
  }

  /**
   * Gets next available key:model combination with optional borrowing
   */
  async getModel(apiName, filterModelName = null) {
    // get api
    let api = this.apis.filter((o) => o.name == apiName)[0];

    if (!api) {
      return {
        key: null,
        model: null,
      };
    }

    let redisKey, modelName, modelMeta, apiKey, validLimits, limitCount, resp;
    let limits = {};
    let { keys, models } = api;

    if (this.modelStrategy == 'random') {
      models = arrayRandom(models);
    }
    if (this.keyStrategy == 'random') {
      keys = arrayRandom(keys);
    }

    if (typeof filterModelName == 'string') {
      models = models.filter((o) =>
        o.name.toLowerCase().includes(filterModelName.toLowerCase())
      );
    }

    // loop thru models
    for (let { name: model, meta, limits: modelLimits } of models) {
      // loop thru all keys
      for (let key of keys) {
        apiKey = key;

        validLimits = true;

        let parsedModelLimits = Object.entries(modelLimits)
          .map(([limit, startCount]) => {
            return { limit, startCount, duration: this.customWindows[limit] };
          })
          .filter((o) => o.duration > 0);

        for (let { limit, startCount, duration } of parsedModelLimits) {
          redisKey = `${this.keyPrefix}:${apiName}:${key}:${model}:${limit}`;

          // check if key exists and count is zero
          ({ resp, limitCount } = await this.redis
            .get(redisKey)
            .then((resp) => {
              if (resp !== null) resp = Number(resp);
              return { limitCount: resp !== null ? resp : startCount, resp };
            }));

          // console.log({ limit, resp, limitCount });

          limits[limit] = limitCount;

          if (!limitCount) {
            validLimits = false;
            break;
          }

          if (limitCount) {
            if (!resp && limit in this.customWindows) {
              await this.redis.setex(redisKey, duration, limitCount);
            }
          }
        }

        if (validLimits) break;
      }

      // if valid, set model
      if (validLimits) {
        modelName = model;
        modelMeta = meta || null;
        break;
      }
    }

    // decrease model hits
    if (modelName) {
      let keyPat = `${this.keyPrefix}:${apiName}:${apiKey}:${modelName}:*`;
      let affectedKeys = await this.redis.keys(keyPat);

      for (let redisKey of affectedKeys) {
        this.redis.decr(redisKey);
      }
    }

    // console.log(modelKeys)
    if (!modelName) {
      return {
        model: modelName,
        key: apiKey,
      };
    }

    return {
      key: apiKey,
      model: modelName,
      limits: limits,
      meta: modelMeta,
    };
  }

  async freezeModel(options) {
    validate(freezeOptsSchema, options);
    let { apiName, key, model, duration } = options;

    console.log({ apiName, key, model, duration });
    let redisKeyPat = `${this.keyPrefix}:${apiName}:${key}:${model}:*`;
    let allKeys = await this.redis.keys(redisKeyPat);

    for (let redisKey of allKeys) {
      await this.redis.setex(redisKey, duration, 0);
    }
  }
}

function arrayRandom(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function arrify(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function validate(schema, obj) {
  const check = v.compile(schema);
  let isValid = check(obj);
  if (isValid !== true) {
    throw new Error(isValid[0].message);
  }
}

export default RateLimiter;
