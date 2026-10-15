const { aggregateJewelleryMrp } = require('./pricingAggregation.service');
const { roundHalfUp } = require('../utils/money');

/**
 * The MRP arithmetic on its own, apart from the reads that feed it.
 * computeMrp gathers the inputs (rates, labour, wastage, permissions) and
 * hands them here; the Python worker (calc/calc_worker.py) runs the same
 * sums on the same inputs, and tests/pricingParity.test.js holds the two
 * identical to the last bit. Plain JSON in, plain JSON out.
 *
 * inputs, every value already read off the request and the rate tables:
 *   netWt, grossWt             grams; a net weight of 0 with a gross weight is
 *                              worked out as gross less the stones (see below)
 *   customPurityPercent        a purity typed for this scan, else null
 *   karatPurityPercent         the karat's purity in the shop's gold rows, 0 when none
 *   karatNumber                the karat as a number (18 for "18K"), 0 when none
 *   goldRatePer10g             the selected 24K rate per 10 g (cash or RTGS)
 *   diamonds                   [{ weight, rate, discountPercent, unit? }]
 *   colorstones                [{ weight, rate, unit? }]
 *                              unit 'g': the weight is in grams (5 ct to the
 *                              gram); anything else is carats
 *   labourRatePerUnit          the labour rate
 *   labourUnit                 'Per 10 Gram' divides the rate by ten; 'Percent'
 *                              is that percent of the gold amount; any other
 *                              unit is per gram
 *   labourWeightBasis          'gross' or 'net'
 *   wastagePercent
 *   otherCharges
 *   labourChargeType, wastageCode   carried into the breakdown as they are
 *
 * Returns { breakdown, finalMRP, finalMRPRounded } as the app reads them,
 * plus the figures the audit line logs (effectivePurityPercent,
 * purityAdjustedGoldRatePerGram and the stone line items).
 */

const CARATS_PER_GRAM = 5;
const GRAMS_PER_CARAT = 0.2;
const LABOUR_UNIT_PERCENT = 'Percent';

function computePricing(inputs) {
  const {
    netWt: givenNetWt,
    grossWt: numericGrossWt,
    customPurityPercent,
    karatPurityPercent,
    karatNumber,
    goldRatePer10g,
    diamonds,
    colorstones,
    labourRatePerUnit,
    labourUnit,
    labourWeightBasis,
    wastagePercent: resolvedWastagePercent,
    otherCharges: otherChargesAmount,
    labourChargeType,
    wastageCode,
  } = inputs;

  // If DB lookup failed, derive a fallback purity percent from the karat value
  // e.g. 24K -> 100%, 18K -> 75% (karat/24 * 100)
  const fallbackPurityPercent = karatNumber > 0 ? Math.min(100, (karatNumber / 24) * 100) : 0;

  let effectivePurityPercent =
    customPurityPercent !== null && customPurityPercent !== undefined
      ? customPurityPercent
      : (karatPurityPercent || fallbackPurityPercent);
  effectivePurityPercent = Math.max(0, Math.min(100, effectivePurityPercent));

  // Stone weights are priced in carats. A weight the tag printed in grams
  // (colour stones often are) is five times as many carats.
  const caratsOf = (stone) => (stone.unit === 'g' ? stone.weight * CARATS_PER_GRAM : stone.weight);

  // Diamond amount, line by line and discount-aware
  const diamondLineItems = diamonds.map((dia, index) => {
    const wt = caratsOf(dia);
    const rate = dia.rate;
    const discountPercent = Math.max(0, Math.min(100, dia.discountPercent));
    const baseAmount = wt * rate;
    const amount = baseAmount - baseAmount * (discountPercent / 100);
    return { index: index + 1, weight: wt, rate, discountPercent, amount };
  });
  const diamondAmount = diamondLineItems.reduce((sum, item) => sum + item.amount, 0);

  // Colorstone amount, line by line
  const colorstoneLineItems = colorstones.map((cs, index) => {
    const wt = caratsOf(cs);
    const rate = cs.rate;
    return { index: index + 1, weight: wt, rate, amount: wt * rate };
  });
  const colorstoneAmount = colorstoneLineItems.reduce((sum, item) => sum + item.amount, 0);

  // A tag that prints only its gross weight (a plain gold piece: "Weight
  // 6.750") has no net weight; the metal is then the gross weight less the
  // stones at 0.2 g a carat, to the milligram, never below nothing. It is an
  // estimate, and the breakdown says so.
  const netWeightEstimated = !(givenNetWt > 0) && numericGrossWt > 0;
  let numericNetWt = givenNetWt;
  if (netWeightEstimated) {
    const stoneCarats = [...diamondLineItems, ...colorstoneLineItems].reduce((sum, item) => sum + item.weight, 0);
    numericNetWt = Math.max(0, roundHalfUp(numericGrossWt - GRAMS_PER_CARAT * stoneCarats, 3));
  }

  // Pure weight, selected gold rate and labour charge
  const pureWeight = numericNetWt * (effectivePurityPercent / 100);

  const labourWeightGrams =
    labourWeightBasis === 'gross'
      ? (numericGrossWt > 0 ? numericGrossWt : numericNetWt)
      : numericNetWt;

  const selected24kGoldRatePerGram = (goldRatePer10g || 0) / 10;
  const purityAdjustedGoldRatePerGram = selected24kGoldRatePerGram * (effectivePurityPercent / 100);

  // Gold Amount = Pure Weight × selected 24K RTGS/Cash live rate per gram
  const goldAmount = pureWeight * selected24kGoldRatePerGram;

  let labourAmount = 0;
  if (labourRatePerUnit > 0) {
    if (labourUnit === LABOUR_UNIT_PERCENT) {
      // Percentage labour is that share of the gold's value.
      labourAmount = goldAmount * (labourRatePerUnit / 100);
    } else if (labourUnit === 'Per 10 Gram') {
      labourAmount = labourWeightGrams * (labourRatePerUnit / 10);
    } else {
      labourAmount = labourWeightGrams * labourRatePerUnit;
    }
  }

  // Wastage: the metal the making consumes, charged as gold. It is a share of
  // the metal in the piece, so it runs on the NET weight — the stones are not
  // gold and nothing is lost off them — and at the 24K rate, the same rate
  // the gold line is priced at rather than the rate after karat purity.
  const wastageWeightGrams =
    resolvedWastagePercent > 0 ? numericNetWt * (resolvedWastagePercent / 100) : 0;
  const wastageAmount = wastageWeightGrams * selected24kGoldRatePerGram;

  const aggregation = aggregateJewelleryMrp({
    goldAmount,
    diamondAmount,
    colorstoneAmount,
    labourAmount,
    wastageAmount,
    otherChargesAmount,
  });

  return {
    breakdown: {
      diamondAmount: aggregation.diamondAmount,
      colorstoneAmount: aggregation.colorstoneAmount,
      pureWeight,
      goldRateApplied: selected24kGoldRatePerGram,
      goldAmount: aggregation.goldAmount,
      labourAmount: aggregation.labourAmount,
      labourChargeType,
      // A Masters -> Wastage code the tag's number matched, and nothing else:
      // the item code is never shown as a wastage code.
      wastageCode,
      wastagePercent: resolvedWastagePercent,
      wastageWeightGrams,
      wastageAmount: aggregation.wastageAmount,
      otherCharges: aggregation.otherChargesAmount,
      subtotal: aggregation.subtotal,
      // The net weight priced, and whether it was worked out from the gross
      // weight (low confidence: the tag did not print it).
      netWeightUsed: numericNetWt,
      netWeightEstimated,
    },
    finalMRP: aggregation.finalMRP,
    // The MRP to the rupee, commercial half-up on the decimal the float
    // stands for: 2,59,020.50 on paper (259020.49999999997 in a float) is
    // 2,59,021.
    finalMRPRounded: roundHalfUp(aggregation.finalMRP),
    effectivePurityPercent,
    purityAdjustedGoldRatePerGram,
    diamondLineItems,
    colorstoneLineItems,
  };
}

module.exports = { computePricing, LABOUR_UNIT_PERCENT, CARATS_PER_GRAM, GRAMS_PER_CARAT };
