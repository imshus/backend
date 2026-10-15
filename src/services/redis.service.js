const config = require('../config/env');
const redis = require('../redis/redisClient');
const scanStore = require('./scanStore');
const { scanExpiredError } = require('../utils/scanAccess');

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

// Where scan records (scan:<id>, latest_scan:<biz>:<user>) live: this
// process's memory by default (scanStore: no round trip on the scan path,
// dropped when the scan is over), or Redis as before with SCAN_STORE=redis.
// Read on every call, so the switch needs only a restart.
const scansInMemory = () => String(process.env.SCAN_STORE || 'memory').trim().toLowerCase() !== 'redis';

const setScan = async (scanId, data) => {
  if (scansInMemory()) {
    scanStore.set(scanId, data);
    return;
  }
  return runStoreOp(async (backend) => {
    if (backend === 'memory') {
      memoryStore.set(scanKey(scanId), JSON.stringify(data));
      return;
    }
    await redis.set(`scan:${scanId}`, JSON.stringify(data), "EX", TTL);
  });
};

const getScan = async (scanId) => {
  if (scansInMemory()) return scanStore.get(scanId);
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
  if (scansInMemory()) {
    scanStore.remove(scanId);
    return;
  }
  return runStoreOp(async (backend) => {
    if (backend === 'memory') {
      memoryStore.delete(scanKey(scanId));
      return;
    }
    await redis.del(scanKey(scanId));
  });
};

/**
 * The scan is over: superseded by the same person's newer scan, or invoiced.
 * In memory it is dropped once nothing has touched it for a short grace;
 * Redis keeps it to its TTL, as it always did.
 */
const finishScan = async (scanId, reason) => {
  if (!scanId || !scansInMemory()) return false;
  return scanStore.finish(scanId, reason);
};

/**
 * An invoice was made: the person's latest scan is finished, when it is one
 * that was read (an invoice is made from a scan's card). A session the
 * scanner opened and nothing was read into is left alone; the next photo
 * goes into it.
 */
const finishLatestAnalyzedScan = async (businessId, userId, reason) => {
  if (!businessId || !userId || !scansInMemory()) return false;
  const scanId = scanStore.getLatest(businessId, userId);
  const scan = scanId ? scanStore.peek(scanId) : null;
  if (!scan?.analysisResult) return false;
  return scanStore.finish(scanId, reason);
};

const getLatestScanIdForUser = async (businessId, userId) => {
  if (scansInMemory()) return scanStore.getLatest(businessId, userId);
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
  if (scansInMemory()) {
    scanStore.setLatest(businessId, userId, scanId);
    return;
  }
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
    if (!scan) throw scanExpiredError();

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

/** Claims a reservation, returning false unless this owner (business:user) made it. */
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

// === GOLD RATES CACHING (THIS PROCESS) ===
// The rates a business (or an employee with rate settings of their own)
// prices on, worked out from the board and its settings. Held in this
// process's memory, not Redis: every scan reads them, and a Redis read is a
// round trip to us-east-1 on the scan's wait. Each entry is served only while
// the board reads as it did when it was worked out (feedStamp, checked by
// rateCalculation) and while no invalidation has happened since (the
// generation below); every settings save and every MCX or house-line move
// clears it, as it cleared the Redis copy.

const GOLD_RATES_MAX_ENTRIES = 5000;
/** cacheId -> { json, generation }, oldest first. */
const goldRatesMemo = new Map();
// Every invalidation moves a generation on: the business's own for a
// settings save, the shared one for a move on the board or the supreme
// changes. A compute that began before an invalidation and finished after it
// used to write the older settings into the cache for the day; it now writes
// only while the generation it read is still the current one, and an entry
// is served only under the generation it was written in.
const goldRatesGenerations = new Map();
let goldRatesSharedGeneration = 0;

const baseBusinessId = (businessId) => String(businessId).split(':')[0];

const currentGoldRatesGeneration = (businessId) =>
  goldRatesSharedGeneration + Number(goldRatesGenerations.get(baseBusinessId(businessId)) || 0);

const getGoldRatesGeneration = async (businessId) => currentGoldRatesGeneration(businessId);

const bumpGoldRatesGeneration = async (businessId) => {
  const base = baseBusinessId(businessId);
  goldRatesGenerations.set(base, Number(goldRatesGenerations.get(base) || 0) + 1);
};

const setGoldRatesCache = async (businessId, data) => {
  const key = String(businessId);
  goldRatesMemo.delete(key);
  goldRatesMemo.set(key, { json: JSON.stringify(data), generation: currentGoldRatesGeneration(key) });
  while (goldRatesMemo.size > GOLD_RATES_MAX_ENTRIES) {
    goldRatesMemo.delete(goldRatesMemo.keys().next().value);
  }
};

const getGoldRatesCache = async (businessId) => {
  const key = String(businessId);
  const entry = goldRatesMemo.get(key);
  if (!entry) return null;
  if (entry.generation !== currentGoldRatesGeneration(key)) {
    goldRatesMemo.delete(key);
    return null;
  }
  return JSON.parse(entry.json);
};

// A business's rates are cached once for the shop and once more for every
// employee who keeps their own rate settings; a change to the shop's inputs
// invalidates all of them.
const invalidateGoldRatesCache = async (businessId) => {
  const base = baseBusinessId(businessId);
  await bumpGoldRatesGeneration(base);
  for (const key of [...goldRatesMemo.keys()]) {
    if (key === base || key.startsWith(`${base}:u:`)) goldRatesMemo.delete(key);
  }
};

const invalidateAllGoldRatesCache = async () => {
  goldRatesSharedGeneration += 1;
  goldRatesMemo.clear();
};

// === MCX API CACHING ===
// Keep latest successful MCX snapshot persistent across nights/weekends.

function mcxKey() {
  return `mcx_gold_live_rate`;
}

// === PROMPT CUSTOMIZATIONS (DIAMOND) ===
// v2: the id became per user (scopeCacheId) on 11 Sep 2026. The v1 blob had
// every employee's private grades pooled under the shop, and each owner write
// renewed its TTL; it is left to expire unread rather than inherited.
function promptCustomKey(category = 'diamond', businessId = 'global') {
  return `prompt_custom_v2:${category}:${businessId || 'global'}`;
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
        source: 'board',
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
          source: 'board',
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
        source: 'board',
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

// This process writes every copy (the scheduler on each board snapshot, the
// supreme-rates screen), so it also keeps the last one in memory: a rate
// compute reads that instead of paying a Redis round trip, and Redis is read
// only by a process that has not written one yet.
let supremeMemo = null;

const setSupremeCache = async (data) => {
  supremeMemo = JSON.stringify(data);
  return runStoreOp(async (backend) => {
    if (backend === 'memory') {
      memoryStore.set(supremeKey(), JSON.stringify(data));
      return;
    }
    await redis.set(supremeKey(), JSON.stringify(data));
  });
};

const getSupremeCache = async () => {
  if (supremeMemo !== null) return JSON.parse(supremeMemo);
  const stored = await runStoreOp(async (backend) => {
    if (backend === 'memory') {
      const data = memoryStore.get(supremeKey());
      return data || null;
    }
    const data = await redis.get(supremeKey());
    return data || null;
  });
  if (stored && supremeMemo === null) supremeMemo = String(stored);
  return stored ? JSON.parse(stored) : null;
};

module.exports = {
  setScan,
  getScan,
  deleteScan,
  finishScan,
  finishLatestAnalyzedScan,
  getLatestScanIdForUser,
  setLatestScanIdForUser,
  updateScanStatus,
  setInvoicePdfCache,
  getInvoicePdfCache,
  reserveInvoiceToken,
  claimInvoiceToken,
  setGoldRatesCache,
  getGoldRatesCache,
  getGoldRatesGeneration,
  bumpGoldRatesGeneration,
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
