/**
 * Seeded realistic pricingMath inputs, shared by tests/pricingParity.test.js
 * and scripts/calc_engine_latency.js: the same cases on every run and every
 * machine.
 */

// mulberry32.
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KARAT_PURITY = { 22: 91.6, 20: 85, 18: 75, 14: 58.5, 9: 39 };

/** One realistic price's pricingMath inputs. */
function realisticInputs(rnd) {
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const fixed = (lo, hi, dp) => Number((lo + rnd() * (hi - lo)).toFixed(dp));

  const netWt = fixed(0.1, 150, 3);
  const karat = pick([9, 14, 18, 20, 22, 24]);
  // The shop's gold rows usually hold the karat (24K never does: it falls
  // back to karat/24); now and then they are missing.
  const karatPurityPercent = rnd() < 0.85 ? (KARAT_PURITY[karat] || 0) : 0;
  const customPurityPercent = rnd() < 0.15
    ? pick([fixed(30, 100, 2), 91.6, 99.9, 75, 58.33, 105, -2])
    : null;
  // RTGS is a whole rupee figure (Math.round upstream); cash keeps paise.
  const cash = rnd() < 0.5;
  const goldRatePer10g = cash ? fixed(60000, 200000, 2) : Math.round(fixed(60000, 200000, 2));

  const stoneCount = Math.floor(rnd() * 31);
  const diamondCount = Math.floor(rnd() * (stoneCount + 1));
  const diamonds = Array.from({ length: diamondCount }, () => ({
    weight: fixed(0.001, 5, 3),
    rate: rnd() < 0.7 ? Math.round(fixed(10000, 200000, 0)) : fixed(10000, 200000, 2),
    discountPercent: pick([0, 0, 0, 5, 10, 12.5, 15, 20, 33.33, 100, 120, -5]),
  }));
  const colorstones = Array.from({ length: stoneCount - diamondCount }, () => ({
    weight: fixed(0.001, 5, 3),
    rate: rnd() < 0.7 ? Math.round(fixed(500, 50000, 0)) : fixed(500, 50000, 2),
  }));
  const stoneGrams = [...diamonds, ...colorstones].reduce((sum, stone) => sum + stone.weight * 0.2, 0);
  const grossWt = rnd() < 0.1 ? 0 : Number((netWt + stoneGrams + rnd() * 2).toFixed(3));

  // Today's arithmetic: 'Per 10 Gram' divides the rate by ten and every
  // other unit or charge type is weight x rate; reproduced as it is.
  const labour = pick([
    () => ({ labourUnit: 'Per Gram', labourWeightBasis: 'net', labourRatePerUnit: fixed(0, 3000, 2), labourChargeType: 'AMOUNT_GLOBAL' }),
    () => ({ labourUnit: 'Per Gram', labourWeightBasis: 'gross', labourRatePerUnit: fixed(0, 3000, 2), labourChargeType: 'AMOUNT_MANUAL' }),
    () => ({ labourUnit: 'Per 10 Gram', labourWeightBasis: pick(['net', 'gross']), labourRatePerUnit: fixed(0, 20000, 2), labourChargeType: 'AMOUNT_GLOBAL' }),
    () => ({ labourUnit: 'Per Piece', labourWeightBasis: 'net', labourRatePerUnit: fixed(0, 5000, 0), labourChargeType: 'AMOUNT_MANUAL' }),
    () => ({ labourUnit: 'Per Gram', labourWeightBasis: 'net', labourRatePerUnit: fixed(0, 25, 2), labourChargeType: 'PERCENTAGE_GLOBAL' }),
    () => ({ labourUnit: 'Fixed', labourWeightBasis: 'net', labourRatePerUnit: fixed(0, 50000, 0), labourChargeType: 'AMOUNT_MANUAL' }),
    () => ({ labourUnit: 'Per Gram', labourWeightBasis: 'net', labourRatePerUnit: 0, labourChargeType: 'NONE' }),
  ])();

  return {
    netWt,
    grossWt,
    customPurityPercent,
    karatPurityPercent,
    karatNumber: karat,
    goldRatePer10g,
    diamonds,
    colorstones,
    ...labour,
    wastagePercent: rnd() < 0.4 ? 0 : fixed(0, 20, 2),
    wastageCode: pick(['', '', 'W8', 'W12', 'WX-5']),
    otherCharges: rnd() < 0.5 ? 0 : fixed(0, 5000, 2),
  };
}

module.exports = { seeded, realisticInputs };
