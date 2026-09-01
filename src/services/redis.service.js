const config = require('../config/env');
const redis = require('../redis/redisClient');

// 24 hours
const TTL = 24 * 60 * 60;
// Invoice PDFs are immutable after generation. Keep a longer-lived copy in
// Redis so a QR scan can download the document without calling PDFMonkey.
// MongoDB + the PDFMonkey document id remain the durable fallback after expiry.
const INVOICE_PDF_TTL = config.invoicePdfCache?.ttlSeconds || (7 * 24 * 60 * 60);
const MAX_INVOICE_PDF_BYTES = config.invoicePdfCache?.maxBytes || (15 * 1024 * 1024);
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

function invoicePdfKey(publicToken) {
  return `invoice_pdf:${publicToken}`;
}

function invoiceTokenReservationKey(publicToken) {
  return `invoice_token:${publicToken}`;
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

// === PUBLIC INVOICE PDF CACHING ===

/**
 * Saves an immutable invoice PDF under the same unguessable token encoded in
 * its QR code. JSON/base64 is intentional: it works with both ioredis and the
 * development in-memory client without a separate binary API.
 */
const setInvoicePdfCache = async (publicToken, invoiceNumber, pdfBuffer) => {
  if (!/^[a-f0-9]{32}$/.test(String(publicToken || ''))) {
    throw new Error('Invalid public invoice token');
  }

  const bytes = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer || []);
  if (!bytes.length || bytes.length > MAX_INVOICE_PDF_BYTES) {
    throw new Error('Cannot cache an empty or oversized invoice PDF');
  }
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('Cannot cache a non-PDF invoice response');
  }

  const payload = JSON.stringify({
    invoiceNumber: String(invoiceNumber || 'invoice'),
    contentType: 'application/pdf',
    pdfBase64: bytes.toString('base64'),
  });

  return runStoreOp(async (backend) => {
    const key = invoicePdfKey(publicToken);
    if (backend === 'memory') {
      memoryStore.set(key, payload);
      return;
    }
    await redis.set(key, payload, 'EX', INVOICE_PDF_TTL);
  });
};

const getInvoicePdfCache = async (publicToken) => {
  return runStoreOp(async (backend) => {
    const key = invoicePdfKey(publicToken);
    const data = backend === 'memory'
      ? memoryStore.get(key)
      : await redis.get(key);

    if (!data) return null;

    try {
      const parsed = JSON.parse(data);
      const pdfBuffer = Buffer.from(String(parsed.pdfBase64 || ''), 'base64');
      if (
        !pdfBuffer.length
        || pdfBuffer.length > MAX_INVOICE_PDF_BYTES
        || pdfBuffer.subarray(0, 5).toString('ascii') !== '%PDF-'
      ) {
        throw new Error('Cached value is not a valid invoice PDF');
      }

      return {
        invoiceNumber: String(parsed.invoiceNumber || 'invoice'),
        contentType: 'application/pdf',
        pdfBuffer,
      };
    } catch (err) {
      console.warn('[invoice-cache] Ignoring invalid cached PDF:', err.message);
      if (backend === 'memory') memoryStore.delete(key);
      else await redis.del(key);
      return null;
    }
  });
};

// === GOLD RATES CACHING ===

function goldKey(businessId) {
  return `gold_rates:${businessId}`;
}

/**
 * Holds a public invoice token that has been shown to a user but not yet
 * spent, so the QR in the preview is the very same code the PDF ends up
 * carrying. Bound to the business that reserved it, and short-lived because an
 * abandoned preview should not keep one alive.
 */
const RESERVED_INVOICE_TOKEN_TTL = 60 * 60;

const reserveInvoiceToken = async (publicToken, businessId) => {
  if (!/^[a-f0-9]{32}$/.test(String(publicToken || ''))) {
    throw new Error('Invalid public invoice token');
  }
  return runStoreOp(async (backend) => {
    const key = invoiceTokenReservationKey(publicToken);
    if (backend === 'memory') {
      memoryStore.set(key, String(businessId));
      return;
    }
    await redis.set(key, String(businessId), 'EX', RESERVED_INVOICE_TOKEN_TTL);
  });
};

/** Claims a reservation, returning false unless this business made it. */
const claimInvoiceToken = async (publicToken, businessId) => {
  if (!/^[a-f0-9]{32}$/.test(String(publicToken || ''))) return false;
  return runStoreOp(async (backend) => {
    const key = invoiceTokenReservationKey(publicToken);
    const owner = backend === 'memory' ? memoryStore.get(key) : await redis.get(key);
    if (!owner || String(owner) !== String(businessId)) return false;
    if (backend === 'memory') memoryStore.delete(key);
    else await redis.del(key);
    return true;
  });
};

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
  setInvoicePdfCache,
  getInvoicePdfCache,
  reserveInvoiceToken,
  claimInvoiceToken,
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
