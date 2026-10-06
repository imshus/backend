const mcxService = require('./mcx.service');
const GoldTaxSetting = require('../models/goldTaxSetting.model');
const GoldRate = require('../models/goldRate.model');
const redisService = require('./redis.service');
const SupremeChange = require('../models/supremeChange.model');
const DashboardMetrics = require('../models/dashboardMetrics.model');
const BullionSource = require('../models/bullionSource.model');
const bhawService = require('./bhaw.service');
const { findScopedSetting } = require('./userScope.service');
const { RUNNING_COMMIT } = require('../utils/runningCommit');

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

/**
 * What RTGS Rate 2's Tax box holds until the shop types otherwise: 0, at
 * the shop's asking — Rate 2 (without tax) is the board figure itself
 * unless the shop takes something off it.
 */
const RTGS_RATE2_DEFAULT_TAX_PERCENT = 0;

const getLiveGoldRates = async (businessId, scope = null) => {
  if (!businessId) throw new Error('Business ID is required');

  // Whose rate settings apply: an employee's own when they have saved any,
  // otherwise the shop's. An employee gets their own cache entry; the owner
  // and everyone inheriting the shop's settings share the business one.
  const settings = { businessId, userId: scope?.userId || null };
  const cacheId = settings.userId ? `${businessId}:u:${settings.userId}` : businessId.toString();

  // 1. Check Redis Cache First. An entry without bhawSource was computed by a
  // pre-vendor-selection build; serving it would pin stale rates for up to the
  // cache TTL after a deploy, so treat it as a miss and recompute.
  const cachedData = await redisService.getGoldRatesCache(cacheId);
  // Served only by the deployment that worked it out: a deploy that changes
  // the rules (a saved 0 once read as 3) must not keep answering with the
  // last one's figures until the board happens to move, which at night was
  // hours.
  if (
    cachedData
    && cachedData.bhawSource
    && cachedData.feedStamp !== undefined
    && cachedData.build === RUNNING_COMMIT
  ) {
    // Served only while the followed house's board still reads as it did
    // when this was computed: a bhaw or MCX-line move is a new rate.
    const stampNow = await bhawService.feedStamp(cachedData.bhawSource.key);
    if (stampNow === cachedData.feedStamp) return cachedData;
  }
  // The generation read before anything else: a save that lands while this
  // computes bumps it, and the result is then not cached.
  const generation = await redisService.getGoldRatesGeneration(businessId);

  // 2-6. Independent reads, fetched together. They used to run one after
  // another, so a cache miss (every MCX tick clears the cache for every
  // business) paid for five round trips in sequence plus the vendor feed.
  // The vendor rows are warmed here too, so the lookup by name below finds
  // them ready.
  const bhawWarm = bhawService.prefetch();
  const [mcxLiveRate, taxSettingsDoc, supremeRead, metrics, bullionSetting, karatRowsRead] = await Promise.all([
    mcxService.getLiveMcxRate24K(),
    findScopedSetting(GoldTaxSetting, settings),
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
      .then(() => findScopedSetting(DashboardMetrics, settings))
      .catch((metricsError) => {
        console.warn('[Gold Rates] Could not read bhaw source preference:', metricsError.message);
        return null;
      }),
    // Which bullion house this account follows. Missing is normal: accounts
    // that never opened the setting still carry the older boolean.
    Promise.resolve()
      .then(() => findScopedSetting(BullionSource, settings))
      .catch((bullionError) => {
        console.warn('[Gold Rates] Could not read the bullion house:', bullionError.message);
        return null;
      }),
    // Both the shop's rows and (for an employee) their own copy, one query;
    // whichever set applies is picked below.
    GoldRate.find({
      businessId,
      $or: [{ userId: null }, ...(settings.userId ? [{ userId: settings.userId }] : [])],
    }),
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
  // Both feed vendors are published by the same live feed, so the selected one
  // is fetched by name. Only if that vendor is unavailable do we keep the
  // stored supreme changes as a fallback.
  //
  // Every house on the feed can be followed. Anything else in the record —
  // a name the shop added — falls back to the boolean rather than being
  // asked of a feed that has never heard of it.
  const FEED_SOURCES = Object.values(bhawService.SOURCES);
  const storedSource = String(bullionSetting?.selected || '').trim();
  const selectedBhawSource = FEED_SOURCES.includes(storedSource)
    ? storedSource
    // Unset means JMD Patil, the default; only a saved "off" means the other house.
    : metrics?.metricsData?.bhaw_source_jmd === false
      ? bhawService.SOURCES.MEGA_BULLION
      : bhawService.SOURCES.JMD_PATIL;
  const vendorBhaw = await bhawService.getBhawForSource(selectedBhawSource);
  if (vendorBhaw) {
    // Per side: the house's own bhaw where it has published one, the
    // stored fallback for the side it has not — a scan on that side still
    // needs a number. The screens show a blank for that side instead.
    supremeChanges = {
      rtgsChange: vendorBhaw.rtgsBhaw ?? supremeChanges.rtgsChange,
      cashChange: vendorBhaw.cashBhaw ?? supremeChanges.cashChange
    };
  }
  const bhawSource = {
    key: selectedBhawSource,
    name: vendorBhaw?.name || bhawService.SOURCE_NAMES[selectedBhawSource] || selectedBhawSource,
    live: Boolean(vendorBhaw),
  };

  // Compose final rates: MCX + SupremeChange + Business (taxSettings)
  const supremeRtgsChange = supremeChanges.rtgsChange || 0;
  const supremeCashChange = supremeChanges.cashChange || 0;
  const mcxChange = normalizeMcxChange(taxSettings.mcxChange);
  const businessMcxChange = mcxChange.signed;
  const businessRtgsChange = taxSettings.rtgsChangeBy || 0;
  const businessCashChange = taxSettings.cashChangeBy || 0;

  // The MCX shown as MCX is the market's (the figure most houses agree on).
  // The followed house's RTGS and Cash are built on that house's own MCX
  // line, the one its bhaw is quoted over: houses do not all quote the same
  // contract, and the house's bhaw on another contract's MCX is a rate the
  // house does not charge. Off the live feed, the stored fallback changes
  // go on the market MCX as before.
  // The MCX shown is the followed house's own "Gold Future MCX" — the shop
  // follows one house, and its MCX is that house's, straight off its
  // Dashboard Settings card. The market majority (mcxLiveRate) stands in
  // only for a house with no line. The house line is read whenever the
  // house has one, live bhaw or not.
  const houseMcx = await bhawService.houseMcxSell(selectedBhawSource);
  const shownMcxRate = houseMcx ?? mcxLiveRate;
  const mcxFinalRate = shownMcxRate + businessMcxChange;
  const pricingMcxRate = shownMcxRate + businessMcxChange;
  // RTGS Rate 1 is the house's board RTGS (its line + its bhaw) as Dashboard
  // Settings shows it, plus the shop's change, with no tax on it (it carried
  // 3% until the shop asked for the board figure itself). The one the shop
  // selected is the RTGS rate everything downstream prices on. A scan must
  // have a number, so a house with no bhaw still gets the stored fallback
  // here; the screens show a blank for it instead.
  const rtgsBaseRate = pricingMcxRate + supremeRtgsChange + businessRtgsChange;
  const rtgsRate1FinalRate = Math.round(rtgsBaseRate);
  // Rate 2 is the board figure less the percent in its Tax box. A saved
  // number is what the shop chose; a field never saved reads as the
  // default 0, the board figure itself.
  const savedTaxPercent = Number(taxSettings.rtgsTaxPercent);
  const rtgsTaxPercent = taxSettings.rtgsTaxPercent != null && Number.isFinite(savedTaxPercent)
    ? savedTaxPercent
    : RTGS_RATE2_DEFAULT_TAX_PERCENT;
  // Rate 2 (without tax) is Rate 1's figure (the board RTGS plus the shop's
  // change) with the Tax box's percent taken out of it: divided by
  // 1 + percent/100, so 3 divides by 1.03 and 4 by 1.04, at the shop's
  // asking; 0 leaves it as Rate 1. One rounding, at the end, as the app does.
  const rtgsRate2FinalRate = Math.round(rtgsBaseRate / (1 + rtgsTaxPercent / 100));
  // Rate 1 is ticked unless the shop ticked Rate 2.
  const rtgsVariant = taxSettings.rtgsVariant === 'plain' ? 'plain' : 'taxed';
  const rtgsFinalRate = rtgsVariant === 'taxed' ? rtgsRate1FinalRate : rtgsRate2FinalRate;
  const cashFinalRate = pricingMcxRate + supremeCashChange + businessCashChange;

  // 5. Determine Base Rate for Karat Calculations
  const baseRate = taxSettings.scannerCalculationUse === 'cash' ? cashFinalRate : rtgsFinalRate;

  // 6. Pick this account's gold rows: an employee's own copy when they have
  // one, else the shop's (userId null, which legacy rows also match).
  const ownRows = settings.userId
    ? karatRowsRead.filter((row) => String(row.userId || '') === String(settings.userId))
    : [];
  const activeUserId = ownRows.length > 0 ? settings.userId : null;
  let karatRows = ownRows.length > 0 ? ownRows : karatRowsRead.filter((row) => !row.userId);

  // Initialize missing default rows if they don't exist — in the same set
  // that is being read.
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
        userId: activeUserId,
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
  // The MCX 24K rate counts as 100%: a row's rate is its purity as a
  // fraction of that — 92% purity is 0.92 of the MCX rate — at the shop's
  // asking. It was a fraction of 99.9 before, which priced every karat a
  // touch above the shop's own arithmetic.
  const computedKaratRates = karatRows.map(row => {
    const basePurityRate = baseRate * (row.purity / 100);
    let finalRate = basePurityRate;

    if (row.increaseByAmount && !isNaN(row.increaseByAmount)) {
      if (row.increaseByType === 'PERCENTAGE') {
        finalRate = basePurityRate + (basePurityRate * (row.increaseByAmount / 100));
      } else {
        finalRate = basePurityRate + row.increaseByAmount;
      }
    }

    // Compute all three rates explicitly for the UI dashboard
    const mcxRate = Math.round(mcxFinalRate * (row.purity / 100));
    const cashRate = Math.round(cashFinalRate * (row.purity / 100));
    const rtgsRate = Math.round(rtgsFinalRate * (row.purity / 100));

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
      rtgsTaxPercent,
      rtgsVariant,
      rtgsRate1FinalRate,
      rtgsRate2FinalRate,
      rtgsFinalRate,
      cashFinalRate,
      // The MCX this shop's RTGS and Cash were built on, before its own MCX
      // change: the followed house's line while its bhaw is live, else the
      // market MCX. The app builds on the same figure while its own board
      // feed is not in, so Home never pairs a house's bhaw with another
      // contract's MCX. Once it is in, the phone's Home and Settings show
      // the live stream while the server prices on the 3-minute snapshot
      // with the same arithmetic, so the two can differ by up to three
      // minutes of market movement.
      pricingMcxLiveRate: houseMcx ?? mcxLiveRate
    },
    karatRates: computedKaratRates,
    feedStamp: vendorBhaw ? `${houseMcx}|${vendorBhaw.cashBhaw}|${vendorBhaw.rtgsBhaw}` : 'off',
    build: RUNNING_COMMIT
  };

  // 9. Cache best-effort. API response must not fail if cache backend is degraded.
  try {
    if ((await redisService.getGoldRatesGeneration(businessId)) === generation) {
      await redisService.setGoldRatesCache(cacheId, responseData);
    }
  } catch (cacheError) {
    console.warn('[Gold Rates] Failed to cache computed rates. Serving fresh response:', cacheError.message);
  }

  return responseData;
};

module.exports = {
  getLiveGoldRates
};
