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

  // 1. Check Redis Cache First
  const cachedData = await redisService.getGoldRatesCache(businessId.toString());
  if (cachedData) {
    return cachedData;
  }

  // 2. Fetch MCX Live Rate (The Supreme Truth)
  const mcxLiveRate = await mcxService.getLiveMcxRate24K();

  // 3. Fetch Gold Tax Settings from DB (or assume defaults)
  let taxSettings = await GoldTaxSetting.findOne({ businessId });
  if (!taxSettings) {
    taxSettings = {
      mcxChange: { operation: '+', amount: 0 },
      rtgsChangeBy: 0,
      cashChangeBy: 0,
      scannerCalculationUse: 'rtgs'
    };
  }

  // 4. Fetch Supreme changes (global) and compute Live Final Tax Rates
  let supremeCache = await redisService.getSupremeCache();
  let supremeChanges = null;
  if (supremeCache) {
    supremeChanges = {
      rtgsChange: supremeCache.rtgsChange || 0,
      cashChange: supremeCache.cashChange || 0
    };
  } else {
    const supreme = await SupremeChange.findOne().sort({ updatedAt: -1, createdAt: -1 });
    supremeChanges = {
      rtgsChange: supreme && typeof supreme.rtgsChange === 'number' ? supreme.rtgsChange : 0,
      cashChange: supreme && typeof supreme.cashChange === 'number' ? supreme.cashChange : 0
    };
  }

  // 4b. Bhaw source: a business can adjust its gold rates from the JMD Patil
  // live feed instead of the Mega Bullion (supreme) changes. Falls back to
  // supreme values whenever the feed is unavailable.
  // Never let the bhaw-source lookup break rate delivery: a malformed
  // businessId or a metrics outage falls back to the supreme changes.
  let metrics = null;
  try {
    metrics = await DashboardMetrics.findOne({ businessId });
  } catch (metricsError) {
    console.warn('[Gold Rates] Could not read bhaw source preference:', metricsError.message);
  }
  if (metrics?.metricsData?.bhaw_source_jmd) {
    const jmdBhaw = await bhawService.getJmdBhaw();
    if (jmdBhaw) {
      supremeChanges = {
        rtgsChange: jmdBhaw.rtgsBhaw,
        cashChange: jmdBhaw.cashBhaw
      };
    }
  }

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
  let karatRows = await GoldRate.find({ businessId });
  
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
