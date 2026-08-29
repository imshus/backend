const config = require('../config/env');
const redis = require('../redis/redisClient');

// 24 hours
const TTL = 24 * 60 * 60;
const memoryStore = new Map();

let useMemoryStore = process.env.USE_MEMORY_STORE === 'true';

function shouldFallbackToMemory(err) {
  const message = String(err?.message || '').toUpperCase();
  return (
    message.includes('READONLY')
    || message.includes('ECONNREFUSED')
    || message.includes('ETIMEDOUT')
    || message.includes('CONNECTION IS CLOSED')
    || message.includes('CONNECTION CLOSED')
    || message.includes('NR_CLOSED')
    || message.includes('NOT CONNECTED')
    || message.includes('CLUSTERDOWN')
  );
}

function scanKey(scanId) {
  return `scan:${scanId}`;
}

function latestUserScanKey(businessId, userId) {
  return `latest_scan:${businessId}:${userId}`;
}

function enableMemoryFallback(reason) {
  if (!useMemoryStore) {
    useMemoryStore = true;
    console.warn(`[scan-store] Redis unavailable (${reason}). Using in-memory store for development.`);
  }
}

async function runStoreOp(operation) {
  if (useMemoryStore) {
    return operation('memory');
  }

  if (!redis) {
    enableMemoryFallback('redis client unavailable');
    return operation('memory');
  }

  try {
    return await operation('redis');
  } catch (err) {
    if (config.env === 'development' || shouldFallbackToMemory(err)) {
      enableMemoryFallback(err.message);
      return operation('memory');
    }
    throw err;
  }
}

const setScan = async (scanId, data) => {
  return runStoreOp(async (backend) => {
    if (backend === 'memory') {
      memoryStore.set(scanKey(scanId), JSON.stringify(data));
      return;
    }
    await redis.set(`scan:${scanId}`, JSON.stringify(data), "EX", TTL);
  });
};

const getScan = async (scanId) => {
  return runStoreOp(async (backend) => {
    if (backend === 'memory') {
      const data = memoryStore.get(scanKey(scanId));
      return data ? JSON.parse(data) : null;
    }

    const data = await redis.get(scanKey(scanId));
    return data ? JSON.parse(data) : null;
  });
};

const deleteScan = async (scanId) => {
  return runStoreOp(async (backend) => {
    if (backend === 'memory') {
      memoryStore.delete(scanKey(scanId));
      return;
    }
    await redis.del(scanKey(scanId));
  });
};

const getLatestScanIdForUser = async (businessId, userId) => {
  return runStoreOp(async (backend) => {
    const key = latestUserScanKey(businessId, userId);
    if (backend === 'memory') {
      const value = memoryStore.get(key);
      return value ? String(value) : null;
    }
    const value = await redis.get(key);
    return value ? String(value) : null;
  });
};

const setLatestScanIdForUser = async (businessId, userId, scanId) => {
  return runStoreOp(async (backend) => {
    const key = latestUserScanKey(businessId, userId);
    if (backend === 'memory') {
      memoryStore.set(key, String(scanId));
      return;
    }
    await redis.set(key, String(scanId), 'EX', TTL);
  });
};

const scanLocks = new Map();

const acquireLock = async (scanId) => {
  while (scanLocks.get(scanId)) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  scanLocks.set(scanId, true);
};

const releaseLock = (scanId) => {
  scanLocks.delete(scanId);
};

const updateScanStatus = async (scanId, status, extraData = {}) => {
  await acquireLock(scanId);
  try {
    const scan = await getScan(scanId);
    if (!scan) throw new Error('Scan not found');

    const updatedScan = {
      ...scan,
      ...extraData,
      status,
      updatedAt: new Date().toISOString(),
    };

    await setScan(scanId, updatedScan);
    return updatedScan;
  } finally {
    releaseLock(scanId);
  }
};

// === GOLD RATES CACHING ===

function goldKey(businessId) {
  return `gold_rates:${businessId}`;
}

const setGoldRatesCache = async (businessId, data) => {
  return runStoreOp(async (backend) => {
    if (backend === 'memory') {
      memoryStore.set(goldKey(businessId), JSON.stringify(data));
      return;
    }
    await redis.set(goldKey(businessId), JSON.stringify(data), "EX", TTL);
  });
};

const getGoldRatesCache = async (businessId) => {
  return runStoreOp(async (backend) => {
    if (backend === 'memory') {
      const data = memoryStore.get(goldKey(businessId));
      return data ? JSON.parse(data) : null;
    }
    const data = await redis.get(goldKey(businessId));
    return data ? JSON.parse(data) : null;
  });
};

const invalidateGoldRatesCache = async (businessId) => {
  return runStoreOp(async (backend) => {
    if (backend === 'memory') {
      memoryStore.delete(goldKey(businessId));
      return;
    }
    await redis.del(goldKey(businessId));
  });
};

const invalidateAllGoldRatesCache = async () => {
  return runStoreOp(async (backend) => {
    if (backend === 'memory') {
      for (const key of memoryStore.keys()) {
        if (key.startsWith('gold_rates:')) {
          memoryStore.delete(key);
        }
      }
      return;
    }
    // In Redis, delete all keys matching gold_rates:*
    const keys = await redis.keys('gold_rates:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });
};

// === MCX API CACHING ===
// Keep latest successful MCX snapshot persistent across nights/weekends.

function mcxKey() {
  return `mcx_gold_live_rate`;
}

// === PROMPT CUSTOMIZATIONS (DIAMOND) ===
function promptCustomKey(category = 'diamond', businessId = 'global') {
  return `prompt_custom:${category}:${businessId || 'global'}`;
}

const DEFAULT_PROMPT_CUSTOMS = { colors: [], clarities: [], shapes: [], packetCodes: [] };

const getPromptCustomizations = async (category = 'diamond', businessId = 'global') => {
  return runStoreOp(async (backend) => {
    if (backend === 'memory') {
      const data = memoryStore.get(promptCustomKey(category, businessId));
      return data ? JSON.parse(data) : { ...DEFAULT_PROMPT_CUSTOMS };
    }
    const data = await redis.get(promptCustomKey(category, businessId));
    return data ? JSON.parse(data) : { ...DEFAULT_PROMPT_CUSTOMS };
  });
};

const setPromptCustomizations = async (category, customs, businessId = 'global') => {
  return runStoreOp(async (backend) => {
    const payload = JSON.stringify(customs ?? DEFAULT_PROMPT_CUSTOMS);
    if (backend === 'memory') {
      memoryStore.set(promptCustomKey(category, businessId), payload);
      return;
    }
    await redis.set(promptCustomKey(category, businessId), payload, 'EX', TTL);
  });
};

const addPromptCustomization = async (category, type, value, businessId = 'global') => {
  if (!value) {
    return { customizations: await getPromptCustomizations(category, businessId), added: false };
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return { customizations: await getPromptCustomizations(category, businessId), added: false };
  }

  const current = await getPromptCustomizations(category, businessId);
  const key = type === 'color' ? 'colors' : type === 'clarity' ? 'clarities' : 'shapes';
  const existing = new Set((current[key] ?? []).map((item) => String(item).toLowerCase()));
  if (!existing.has(normalized.toLowerCase())) {
    current[key] = [...(current[key] ?? []), normalized];
    await setPromptCustomizations(category, current, businessId);
    return { customizations: current, added: true };
  }
  return { customizations: current, added: false };
};

const setMcxCache = async (data) => {
  return runStoreOp(async (backend) => {
    const payload = (typeof data === 'number')
      ? {
        rate: data,
        timestamp: new Date().toISOString(),
        lastSuccessfulFetchTime: new Date().toISOString(),
        source: 'metals.dev',
        currency: 'INR',
        date: null,
      }
      : data;

    if (backend === 'memory') {
      memoryStore.set(mcxKey(), JSON.stringify(payload));
      return;
    }
    await redis.set(mcxKey(), JSON.stringify(payload));
  });
};

const getMcxCache = async () => {
  const snapshot = await runStoreOp(async (backend) => {
    if (backend === 'memory') {
      const data = memoryStore.get(mcxKey());
      return data ? JSON.parse(data) : null;
    }
    const data = await redis.get(mcxKey());
    return data ? JSON.parse(data) : null;
  });

  if (snapshot === null || snapshot === undefined) {
    return null;
  }
  if (typeof snapshot === 'number') {
    return snapshot;
  }
  if (typeof snapshot.rate === 'number') {
    return snapshot.rate;
  }
  return null;
};

const getMcxCacheSnapshot = async () => {
  return runStoreOp(async (backend) => {
    if (backend === 'memory') {
      const data = memoryStore.get(mcxKey());
      if (!data) {
        return null;
      }
      const parsed = JSON.parse(data);
      return typeof parsed === 'number'
        ? {
          rate: parsed,
          timestamp: null,
          lastSuccessfulFetchTime: null,
          source: 'metals.dev',
          currency: 'INR',
          date: null,
        }
        : parsed;
    }

    const data = await redis.get(mcxKey());
    if (!data) {
      return null;
    }
    const parsed = JSON.parse(data);
    return typeof parsed === 'number'
      ? {
        rate: parsed,
        timestamp: null,
        lastSuccessfulFetchTime: null,
        source: 'metals.dev',
        currency: 'INR',
        date: null,
      }
      : parsed;
  });
};

// === SUPREME RATES CACHING (GLOBAL) ===
function supremeKey() {
  return `supreme_rates`;
}

const setSupremeCache = async (data) => {
  return runStoreOp(async (backend) => {
    if (backend === 'memory') {
      memoryStore.set(supremeKey(), JSON.stringify(data));
      return;
    }
    await redis.set(supremeKey(), JSON.stringify(data));
  });
};

const getSupremeCache = async () => {
  return runStoreOp(async (backend) => {
    if (backend === 'memory') {
      const data = memoryStore.get(supremeKey());
      return data ? JSON.parse(data) : null;
    }
    const data = await redis.get(supremeKey());
    return data ? JSON.parse(data) : null;
  });
};

module.exports = {
  setScan,
  getScan,
  deleteScan,
  getLatestScanIdForUser,
  setLatestScanIdForUser,
  updateScanStatus,
  setGoldRatesCache,
  getGoldRatesCache,
  invalidateGoldRatesCache,
  invalidateAllGoldRatesCache,
  setMcxCache,
  getMcxCache,
  getMcxCacheSnapshot,
  setSupremeCache,
  getSupremeCache,
  getPromptCustomizations,
  addPromptCustomization
};
