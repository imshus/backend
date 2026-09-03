const mcxService = require('./mcx.service');
const GoldTaxSetting = require('../models/goldTaxSetting.model');
const GoldRate = require('../models/goldRate.model');
const redisService = require('./redis.service');
const SupremeChange = require('../models/supremeChange.model');
const DashboardMetrics = require('../models/dashboardMetrics.model');
const bhawService = require('./bhaw.service');

const toNumber = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const normalizeMcxChange = (mcxChange) => {
  if (!mcxChange || typeof mcxChange !== 'object') {
    return { operation: '+', amount: 0, signed: 0 };
  }
  const operation = mcxChange.operation === '-' ? '-' : '+';
  const amount = Math.max(0, toNumber(mcxChange.amount));
  const signed = operation === '-' ? -amount : amount;
  return { operation, amount, signed };
};

const getLiveGoldRates = async (businessId) => {
  if (!businessId) throw new Error('Business ID is required');

  // 1. Check Redis Cache First. An entry without bhawSource was computed by a
  // pre-vendor-selection build; serving it would pin stale rates for up to the
  // cache TTL after a deploy, so treat it as a miss and recompute.
  const cachedData = await redisService.getGoldRatesCache(businessId.toString());
  if (cachedData && cachedData.bhawSource) {
    return cachedData;
  }

  // 2-6. Independent reads, fetched together. They used to run one after
  // another, so a cache miss (every MCX tick clears the cache for every
  // business) paid for five round trips in sequence plus the vendor feed.
  // The vendor rows are warmed here too, so the lookup by name below finds
  // them ready.
  const bhawWarm = bhawService.prefetch();
  const [mcxLiveRate, taxSettingsDoc, supremeRead, metrics, karatRowsRead] = await Promise.all([
    mcxService.getLiveMcxRate24K(),
    GoldTaxSetting.findOne({ businessId }),
    (async () => {
      const supremeCache = await redisService.getSupremeCache();
      if (supremeCache) {
        return {
          rtgsChange: supremeCache.rtgsChange || 0,
          cashChange: supremeCache.cashChange || 0
        };
      }
      const supreme = await SupremeChange.findOne().sort({ updatedAt: -1, createdAt: -1 });
      return {
        rtgsChange: supreme && typeof supreme.rtgsChange === 'number' ? supreme.rtgsChange : 0,
        cashChange: supreme && typeof supreme.cashChange === 'number' ? supreme.cashChange : 0
      };
    })(),
    // Never let the bhaw-source lookup break rate delivery: a malformed
    // businessId or a metrics outage falls back to the supreme changes.
    Promise.resolve()
      .then(() => DashboardMetrics.findOne({ businessId }))
      .catch((metricsError) => {
        console.warn('[Gold Rates] Could not read bhaw source preference:', metricsError.message);
        return null;
      }),
    GoldRate.find({ businessId }),
  ]);
  await bhawWarm;

  // 3. Gold Tax Settings (or defaults)
  let taxSettings = taxSettingsDoc;
  if (!taxSettings) {
    taxSettings = {
      mcxChange: { operation: '+', amount: 0 },
      rtgsChangeBy: 0,
      cashChangeBy: 0,
      scannerCalculationUse: 'rtgs'
    };
  }

  // 4. Supreme changes, unless the selected bhaw vendor is live (4b).
  let supremeChanges = supremeRead;
  // Both vendors are published by the same live feed, so the selected one is
  // fetched by name. Only if that vendor is unavailable do we keep the stored
  // supreme changes as a fallback.
  const selectedBhawSource = metrics?.metricsData?.bhaw_source_jmd
    ? bhawService.SOURCES.JMD_PATIL
    : bhawService.SOURCES.MEGA_BULLION;
  const vendorBhaw = await bhawService.getBhawForSource(selectedBhawSource);
  if (vendorBhaw) {
    supremeChanges = {
      rtgsChange: vendorBhaw.rtgsBhaw,
      cashChange: vendorBhaw.cashBhaw
    };
  }
  const bhawSource = {
    key: selectedBhawSource,
    name: vendorBhaw?.name || (selectedBhawSource === bhawService.SOURCES.JMD_PATIL ? 'JMD Patil' : 'Mega Bullion'),
    live: Boolean(vendorBhaw),
  };

  // Compose final rates: MCX + SupremeChange + Business (taxSettings)
  const supremeRtgsChange = supremeChanges.rtgsChange || 0;
  const supremeCashChange = supremeChanges.cashChange || 0;
  const mcxChange = normalizeMcxChange(taxSettings.mcxChange);
  const businessMcxChange = mcxChange.signed;
  const businessRtgsChange = taxSettings.rtgsChangeBy || 0;
  const businessCashChange = taxSettings.cashChangeBy || 0;

  const mcxFinalRate = mcxLiveRate + businessMcxChange;
  const rtgsFinalRate = mcxFinalRate + supremeRtgsChange + businessRtgsChange;
  const cashFinalRate = mcxFinalRate + supremeCashChange + businessCashChange;

  // 5. Determine Base Rate for Karat Calculations
  const baseRate = taxSettings.scannerCalculationUse === 'cash' ? cashFinalRate : rtgsFinalRate;

  // 6. Fetch Gold Rate Rows from DB
  let karatRows = karatRowsRead;
  
  // Initialize missing default rows if they don't exist
  const requiredCarats = [
    { carat: '22Kt', purity: 91.6 },
    { carat: '20Kt', purity: 85 },
    { carat: '18Kt', purity: 75 },
    { carat: '14Kt', purity: 58.5 },
    { carat: '9Kt', purity: 39 }
  ];

  if (karatRows.length < 5) {
    const existingCarats = karatRows.map(r => r.carat);
    const toCreate = requiredCarats.filter(rc => !existingCarats.includes(rc.carat));
    
    for (const rc of toCreate) {
      const newRate = new GoldRate({
        businessId,
        carat: rc.carat,
        purity: rc.purity,
        increaseByAmount: 0,
        increaseByType: 'FLAT',
        isHidden: false
      });
      await newRate.save();
      karatRows.push(newRate);
    }
  }

  // 7. Calculate Final Live Rates for Each Row
  const computedKaratRates = karatRows.map(row => {
    const basePurityRate = baseRate * (row.purity / 99.9);
    let finalRate = basePurityRate;

    if (row.increaseByAmount && !isNaN(row.increaseByAmount)) {
      if (row.increaseByType === 'PERCENTAGE') {
        finalRate = basePurityRate + (basePurityRate * (row.increaseByAmount / 100));
      } else {
        finalRate = basePurityRate + row.increaseByAmount;
      }
    }

    // Compute all three rates explicitly for the UI dashboard
    const mcxRate = Math.round(mcxFinalRate * (row.purity / 99.9));
    const cashRate = Math.round(cashFinalRate * (row.purity / 99.9));
    const rtgsRate = Math.round(rtgsFinalRate * (row.purity / 99.9));

    return {
      _id: row._id,
      carat: row.carat,
      purity: row.purity,
      increaseByAmount: row.increaseByAmount,
      increaseByType: row.increaseByType,
      isHidden: !!row.isHidden,
      finalRate: Math.round(finalRate * 100) / 100, // Legacy fallback
      mcxRate,
      cashRate,
      rtgsRate
    };
  });

  // Sort rows to maintain consistent order
  const caratOrder = { '22Kt': 1, '20Kt': 2, '18Kt': 3, '14Kt': 4, '9Kt': 5 };
  computedKaratRates.sort((a, b) => caratOrder[a.carat] - caratOrder[b.carat]);

  // 8. Compile the Final Rich Response
  const responseData = {
    mcxLiveRate,
    mcxFinalRate,
    bhawSource,
    supremeChanges: {
      rtgsChange: supremeRtgsChange,
      cashChange: supremeCashChange,
      supremeRtgs: mcxLiveRate + supremeRtgsChange,
      supremeCash: mcxLiveRate + supremeCashChange
    },
    taxSettings: {
      mcxChange: { operation: mcxChange.operation, amount: mcxChange.amount },
      mcxChangeBy: businessMcxChange,
      mcxFinalRate,
      rtgsChangeBy: businessRtgsChange,
      cashChangeBy: businessCashChange,
      scannerCalculationUse: taxSettings.scannerCalculationUse,
      rtgsFinalRate,
      cashFinalRate
    },
    karatRates: computedKaratRates
  };

  // 9. Cache best-effort. API response must not fail if cache backend is degraded.
  try {
    await redisService.setGoldRatesCache(businessId.toString(), responseData);
  } catch (cacheError) {
    console.warn('[Gold Rates] Failed to cache computed rates. Serving fresh response:', cacheError.message);
  }

  return responseData;
};

module.exports = {
  getLiveGoldRates
};
