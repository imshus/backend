const Redis = require('ioredis');
const config = require('../config/env');

let redis = null;

function createMemoryStoreClient() {
  const store = new Map();

  function getEntry(key) {
    const entry = store.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }

    return entry;
  }

  return {
    async get(key) {
      const entry = getEntry(key);
      return entry ? entry.value : null;
    },

    async set(key, value, mode, ttlSeconds) {
      let expiresAt = null;
      if (String(mode).toUpperCase() === 'EX' && Number.isFinite(Number(ttlSeconds))) {
        expiresAt = Date.now() + (Number(ttlSeconds) * 1000);
      }

      store.set(key, {
        value: String(value),
        expiresAt,
      });

      return 'OK';
    },

    async incr(key) {
      const entry = getEntry(key);
      const nextValue = (entry ? Number(entry.value) : 0) + 1;
      store.set(key, {
        value: String(nextValue),
        expiresAt: entry ? entry.expiresAt : null,
      });
      return nextValue;
    },

    async del(key) {
      const existed = store.delete(key);
      return existed ? 1 : 0;
    },
  };
}

if (process.env.USE_MEMORY_STORE !== 'true') {
  redis = new Redis(config.redis.url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    enableOfflineQueue: true,
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
    reconnectOnError: (err) => {
      const targetError = 'READONLY';
      if (err.message.includes(targetError)) {
        return true;
      }
      return false;
    }
  });

  redis.on('connect', () => {
    console.log('[redis] Connected to Redis');
  });

  redis.on('ready', () => {
    console.log('[redis] Redis client ready');
  });

  redis.on('error', (err) => {
    console.error('[redis] Error:', err.message);
  });

  redis.on('reconnecting', () => {
    console.log('[redis] Reconnecting to Redis...');
  });

  redis.on('close', () => {
    console.log('[redis] Redis connection closed');
  });
} else {
  console.log('[redis] USE_MEMORY_STORE=true — skipping Redis connection');
  redis = createMemoryStoreClient();
}

module.exports = redis;
