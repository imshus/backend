const axios = require('axios');
const redisService = require('./redis.service');
const MCXFetch = require('../models/mcxFetch.model');
const SupremeChange = require('../models/supremeChange.model');
const config = require('../config/env');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const WEEKDAY_TO_ISO = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

const schedulerConfig = {
  timezone: config.mcxScheduler.timezone,
  tradingDays: new Set(config.mcxScheduler.tradingDays),
  startSeconds: parseTimeToSeconds(config.mcxScheduler.startTime),
  endSeconds: parseTimeToSeconds(config.mcxScheduler.endTime),
  pollIntervalSeconds: config.mcxScheduler.pollIntervalSeconds,
};

if (schedulerConfig.startSeconds > schedulerConfig.endSeconds) {
  throw new Error('[MCX Scheduler] Invalid trading window: start time must be before end time.');
}

let schedulerTimer = null;

function parseTimeToSeconds(timeValue) {
  const [hours, minutes, seconds] = String(timeValue || '00:00:00').split(':').map(Number);
  if (
    !Number.isInteger(hours)
    || !Number.isInteger(minutes)
    || !Number.isInteger(seconds)
    || hours < 0
    || hours > 23
    || minutes < 0
    || minutes > 59
    || seconds < 0
    || seconds > 59
  ) {
    throw new Error(`Invalid MCX scheduler time value: ${timeValue}`);
  }

  return hours * 3600 + minutes * 60 + seconds;
}

function getIstParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: schedulerConfig.timezone,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const valueByType = (type) => parts.find((part) => part.type === type)?.value;

  return {
    weekday: String(valueByType('weekday') || '').toLowerCase(),
    year: Number(valueByType('year')),
    month: Number(valueByType('month')),
    day: Number(valueByType('day')),
    hour: Number(valueByType('hour')),
    minute: Number(valueByType('minute')),
    second: Number(valueByType('second')),
  };
}

function formatIstDateTime(date = new Date()) {
  const p = getIstParts(date);
  const two = (n) => String(n).padStart(2, '0');
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}:${two(p.second)} IST`;
}

function formatIstTime(date = new Date()) {
  const p = getIstParts(date);
  const two = (n) => String(n).padStart(2, '0');
  return `${two(p.hour)}:${two(p.minute)}:${two(p.second)}`;
}

function isTradingDay(istParts) {
  return schedulerConfig.tradingDays.has(WEEKDAY_TO_ISO[istParts.weekday]);
}

function getSecondsOfDay(istParts) {
  return (istParts.hour * 3600) + (istParts.minute * 60) + istParts.second;
}

function isWithinTradingWindow(istParts) {
  const seconds = getSecondsOfDay(istParts);
  return isTradingDay(istParts)
    && seconds >= schedulerConfig.startSeconds
    && seconds <= schedulerConfig.endSeconds;
}

function addDaysToIstDate(year, month, day, daysToAdd) {
  const utc = new Date(Date.UTC(year, month - 1, day) + (daysToAdd * 24 * 60 * 60 * 1000));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

function createUtcDateFromIst(year, month, day, secondsOfDay) {
  const hours = Math.floor(secondsOfDay / 3600);
  const minutes = Math.floor((secondsOfDay % 3600) / 60);
  const seconds = secondsOfDay % 60;
  const utcMs = Date.UTC(year, month - 1, day, hours, minutes, seconds) - IST_OFFSET_MS;
  return new Date(utcMs);
}

function getNextTradingStartUtc(fromDate = new Date()) {
  const nowIst = getIstParts(fromDate);

  for (let days = 0; days <= 8; days += 1) {
    const candidateDate = addDaysToIstDate(nowIst.year, nowIst.month, nowIst.day, days);
    const candidateWeekday = getIstParts(createUtcDateFromIst(candidateDate.year, candidateDate.month, candidateDate.day, schedulerConfig.startSeconds)).weekday;

    if (!schedulerConfig.tradingDays.has(WEEKDAY_TO_ISO[candidateWeekday])) {
      continue;
    }

    const candidateUtc = createUtcDateFromIst(
      candidateDate.year,
      candidateDate.month,
      candidateDate.day,
      schedulerConfig.startSeconds
    );

    if (candidateUtc > fromDate) {
      return candidateUtc;
    }
  }

  throw new Error('Unable to calculate next MCX trading start.');
}

function getNextScheduledExecutionUtc(fromDate = new Date()) {
  const nowIst = getIstParts(fromDate);
  const nowSeconds = getSecondsOfDay(nowIst);

  if (!isTradingDay(nowIst) || nowSeconds > schedulerConfig.endSeconds) {
    return getNextTradingStartUtc(fromDate);
  }

  if (nowSeconds < schedulerConfig.startSeconds) {
    return createUtcDateFromIst(nowIst.year, nowIst.month, nowIst.day, schedulerConfig.startSeconds);
  }

  const elapsed = nowSeconds - schedulerConfig.startSeconds;
  const slotsPassed = Math.floor(elapsed / schedulerConfig.pollIntervalSeconds);
  const nextSlotSeconds = schedulerConfig.startSeconds + ((slotsPassed + 1) * schedulerConfig.pollIntervalSeconds);

  if (nextSlotSeconds > schedulerConfig.endSeconds) {
    return getNextTradingStartUtc(fromDate);
  }

  return createUtcDateFromIst(nowIst.year, nowIst.month, nowIst.day, nextSlotSeconds);
}

async function fetchAndStoreMcxRate(options = {}) {
  const phase = options.phase === 'startup' ? 'startup' : 'scheduled';
  const attemptAt = new Date();
  try {
    const apiKey = process.env.METALS_API_KEY;
    if (!apiKey) {
      console.error('[MCX Scheduler] METALS_API_KEY is not defined');
      return { success: false, reason: 'METALS_API_KEY missing' };
    }

    if (phase === 'startup') {
      console.log(`[MCX Scheduler] Performing startup synchronization at ${formatIstDateTime(attemptAt)}...`);
    } else {
      console.log(`[MCX Scheduler] Trading session active. Fetching MCX rate at ${formatIstDateTime(attemptAt)}...`);
    }

    const url = `https://api.metals.dev/v1/metal/authority?api_key=${apiKey}&authority=mcx&currency=INR&unit=10g`;
    const response = await axios.get(url, { timeout: 10000 });
    const data = response.data;

    if (!(data && data.status === 'success' && data.rates && data.rates.mcx_gold)) {
      console.error('[MCX Scheduler] Invalid response format from Metals API:', data);
      return { success: false, reason: 'Invalid response format from Metals API' };
    }

    const liveRate = Math.round(data.rates.mcx_gold);
    const oldSnapshot = await redisService.getMcxCacheSnapshot();
    const oldRate = oldSnapshot?.rate ?? null;

    const fetchedAt = new Date();
    const fetchedIst = getIstParts(fetchedAt);
    const mcxSnapshot = {
      rate: liveRate,
      timestamp: fetchedAt.toISOString(),
      lastSuccessfulFetchTime: fetchedAt.toISOString(),
      source: 'metals.dev',
      currency: 'INR',
      date: `${fetchedIst.year}-${String(fetchedIst.month).padStart(2, '0')}-${String(fetchedIst.day).padStart(2, '0')}`,
    };

    await redisService.setMcxCache(mcxSnapshot);
    if (phase === 'startup') {
      console.log(`[MCX Scheduler] Startup MCX fetch successful. Current Rate: INR ${liveRate}`);
    } else {
      console.log(`[MCX Scheduler] MCX updated: INR ${liveRate}`);
    }

    try {
      const supreme = await SupremeChange.findOne().sort({ updatedAt: -1, createdAt: -1 });
      const rtgsChange = (supreme && typeof supreme.rtgsChange === 'number') ? supreme.rtgsChange : 0;
      const cashChange = (supreme && typeof supreme.cashChange === 'number') ? supreme.cashChange : 0;

      const supremeRtgs = liveRate + rtgsChange;
      const supremeCash = liveRate + cashChange;

      await redisService.setSupremeCache({
        mcx: liveRate,
        supremeRtgs,
        supremeCash,
        rtgsChange,
        cashChange,
        rtgsFinalRate: supremeRtgs,
        cashFinalRate: supremeCash,
      });
      console.log('[MCX Scheduler] Updated supreme cache based on latest MCX rate.');
    } catch (err) {
      console.error('[MCX Scheduler] Failed to update supreme cache:', err.message);
    }

    if (oldRate !== null && oldRate !== liveRate) {
      console.log(`[MCX Scheduler] Rate changed from ${oldRate} to ${liveRate}. Invalidating 24-hour dashboard cache.`);
      await redisService.invalidateAllGoldRatesCache();
    }

    const nextExecutionUtc = getNextScheduledExecutionUtc(fetchedAt);
    let fetchRecord = await MCXFetch.findOne();
    if (!fetchRecord) {
      fetchRecord = new MCXFetch({
        lastFetchedTime: fetchedAt,
        expectedNextFetchTime: nextExecutionUtc,
        numberOfApiCall: 1,
      });
    } else {
      fetchRecord.lastFetchedTime = fetchedAt;
      fetchRecord.expectedNextFetchTime = nextExecutionUtc;
      fetchRecord.numberOfApiCall += 1;
    }
    await fetchRecord.save();

    return { success: true, liveRate };
  } catch (error) {
    const context = phase === 'startup' ? 'Startup synchronization failed' : 'Fetch failed';
    console.error(`[MCX Scheduler] ${context} at ${formatIstDateTime(attemptAt)}:`, error.message);
    return { success: false, reason: error.message };
  }
}

function scheduleNextFetch(reason) {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }

  const now = new Date();
  const nextExecution = getNextScheduledExecutionUtc(now);
  const waitMs = Math.max(0, nextExecution.getTime() - now.getTime());

  const nowIst = getIstParts(now);
  if (!isTradingDay(nowIst)) {
    console.log(`[MCX Scheduler] Current IST Time: ${formatIstDateTime(now)} | Weekend detected. Using cached MCX rate.`);
  } else if (getSecondsOfDay(nowIst) < schedulerConfig.startSeconds || getSecondsOfDay(nowIst) > schedulerConfig.endSeconds) {
    console.log(`[MCX Scheduler] Current IST Time: ${formatIstDateTime(now)} | Outside trading window. Using cached MCX rate.`);
  }

  console.log(`[MCX Scheduler] Next scheduler activation (${reason}): ${formatIstDateTime(nextExecution)}`);

  schedulerTimer = setTimeout(async () => {
    const triggerTime = new Date();
    const triggerIst = getIstParts(triggerTime);

    if (!isWithinTradingWindow(triggerIst)) {
      console.log(`[MCX Scheduler] Skipping fetch at ${formatIstDateTime(triggerTime)} (outside trading window).`);
      scheduleNextFetch('window-skip');
      return;
    }

    await fetchAndStoreMcxRate({ phase: 'scheduled' });

    const nextExecutionAfterRun = getNextScheduledExecutionUtc(new Date());
    console.log(`[MCX Scheduler] Next scheduled fetch: ${formatIstTime(nextExecutionAfterRun)} IST`);
    scheduleNextFetch('scheduled-run');
  }, waitMs);
}

async function initMcxScheduler() {
  try {
    const now = new Date();

    console.log('[MCX Scheduler] Backend started.');
    console.log('[MCX Scheduler] Initializing MCX Scheduler...');
    console.log('[MCX Scheduler] Scheduler started.');
    console.log(`[MCX Scheduler] Current IST Time: ${formatIstDateTime(now)}`);
    console.log(
      `[MCX Scheduler] Config => timezone=${schedulerConfig.timezone}, tradingDays=${[...schedulerConfig.tradingDays].join(',')}, `
      + `window=${config.mcxScheduler.startTime}-${config.mcxScheduler.endTime}, interval=${schedulerConfig.pollIntervalSeconds}s`
    );

    // Mandatory one-time startup sync irrespective of day/time window.
    const startupResult = await fetchAndStoreMcxRate({ phase: 'startup' });
    if (!startupResult.success) {
      const cachedSnapshot = await redisService.getMcxCacheSnapshot();
      const fallbackRate = cachedSnapshot?.rate;
      if (typeof fallbackRate === 'number') {
        console.warn(`[MCX Scheduler] Startup synchronization failed. Using cached MCX rate: INR ${fallbackRate}. Reason: ${startupResult.reason}`);
      } else {
        console.warn(`[MCX Scheduler] Startup synchronization failed and no cached MCX rate found. Reason: ${startupResult.reason}`);
      }
    }

    const startupDecisionTime = new Date();
    const istParts = getIstParts(startupDecisionTime);
    console.log(`[MCX Scheduler] Current IST after startup sync: ${formatIstDateTime(startupDecisionTime)}`);

    if (isWithinTradingWindow(istParts)) {
      console.log('[MCX Scheduler] Trading session active. Entering normal scheduler lifecycle.');
    } else {
      const weekdayIso = WEEKDAY_TO_ISO[istParts.weekday];
      if (!schedulerConfig.tradingDays.has(weekdayIso)) {
        console.log('[MCX Scheduler] Weekend detected. Scheduler sleeping until next trading session.');
      } else {
        console.log('[MCX Scheduler] Outside trading window. Scheduler waiting for next valid trading session.');
      }
    }

    scheduleNextFetch('startup-sync');
  } catch (error) {
    console.error('[MCX Scheduler] Failed to initialize scheduler:', error.message);
  }
}

module.exports = {
  initMcxScheduler,
  fetchAndStoreMcxRate,
  __internal: {
    parseTimeToSeconds,
    getIstParts,
    isTradingDay,
    isWithinTradingWindow,
    getNextTradingStartUtc,
    getNextScheduledExecutionUtc,
    createUtcDateFromIst,
    schedulerConfig,
  },
};
