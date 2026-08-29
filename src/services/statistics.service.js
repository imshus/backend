const config = require('../config/env');

const billingTimeZone = config.billing?.timezone || 'Asia/Kolkata';

function getDatePartsInTimeZone(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: billingTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: byType.year,
    month: byType.month,
    day: byType.day,
  };
}

function getStatsKeys(now = new Date()) {
  const { year, month, day } = getDatePartsInTimeZone(now);
  return {
    dayKey: `${year}-${month}-${day}`,
    monthKey: `${year}-${month}`,
  };
}

function resolveScanCounters(wallet, now = new Date()) {
  const { dayKey, monthKey } = getStatsKeys(now);
  const sameDay = wallet.statsDayKey === dayKey;
  const sameMonth = wallet.statsMonthKey === monthKey;

  return {
    todayScans: sameDay ? Number(wallet.todayScans || 0) : 0,
    monthScans: sameMonth ? Number(wallet.monthScans || 0) : 0,
    statsDayKey: dayKey,
    statsMonthKey: monthKey,
  };
}

function nextScanStats(wallet, now = new Date()) {
  const current = resolveScanCounters(wallet, now);
  const todayScans = current.todayScans + 1;
  const monthScans = current.monthScans + 1;
  const lifetimeScans = (wallet.lifetimeScans || 0) + 1;

  return {
    todayScans,
    monthScans,
    lifetimeScans,
    statsDayKey: current.statsDayKey,
    statsMonthKey: current.statsMonthKey,
  };
}

module.exports = {
  getStatsKeys,
  resolveScanCounters,
  nextScanStats,
};
