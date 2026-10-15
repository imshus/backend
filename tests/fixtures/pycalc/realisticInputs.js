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

/**
 * A plain gold piece with per-gram labour (and whole-rupee other charges)
 * whose MRP is EXACTLY x.50 on paper: net m mg at purity p, a whole-rupee
 * rate R per 10 g and labour L per gram total m × (R × 10p + 10000 L) / 10^7
 * rupees, so m is chosen with m × K ≡ 5,000,000 (mod 10^7). In a float many
 * of these land a hair below the tie (259020.49999999997), where
 * Math.round goes down and half-up must go up.
 *
 * `exact` is the MRP to the rupee, half-up, worked out in integers.
 */
const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

/** x with a·x ≡ 1 (mod m), for coprime a and m (all below 10^7, so exact). */
function modularInverse(a, m) {
  let [oldR, r] = [a % m, m];
  let [oldS, s] = [1, 0];
  while (r !== 0) {
    const q = Math.floor(oldR / r);
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % m) + m) % m;
}

const TIE_MODULUS = 10000000;
const TIE_RESIDUE = 5000000;
const MIN_MG = 100;
const MAX_MG = 150000;

function tieInputs(rnd) {
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  for (;;) {
    const karat = pick([22, 20, 18, 14, 9]);
    const purity = KARAT_PURITY[karat];
    const purityTenths = Math.round(purity * 10);
    const rate = 60000 + Math.floor(rnd() * 140000);
    const labour = Math.floor(rnd() * 3000);
    const k = rate * purityTenths + labour * 10000;
    // m·k ≡ 5·10^6 (mod 10^7): solvable when gcd(k, 10^7) divides 5·10^6;
    // the solutions are one residue class mod 10^7 / gcd.
    const g = gcd(k % TIE_MODULUS, TIE_MODULUS);
    if (TIE_RESIDUE % g !== 0) continue;
    const modulus = TIE_MODULUS / g;
    const base = ((TIE_RESIDUE / g) * modularInverse((k / g) % modulus, modulus)) % modulus;
    const first = base + Math.ceil(Math.max(0, MIN_MG - base) / modulus) * modulus;
    if (first > MAX_MG) continue;
    const choices = Math.floor((MAX_MG - first) / modulus) + 1;
    const milligrams = first + Math.floor(rnd() * choices) * modulus;
    if ((milligrams * k) % TIE_MODULUS !== TIE_RESIDUE) throw new Error('tie construction is wrong');
    const otherCharges = rnd() < 0.5 ? 0 : Math.floor(rnd() * 5000);
    const netWt = milligrams / 1000;
    return {
      inputs: {
        netWt,
        grossWt: Number((netWt + rnd() * 2).toFixed(3)),
        customPurityPercent: null,
        karatPurityPercent: purity,
        karatNumber: karat,
        goldRatePer10g: rate,
        diamonds: [],
        colorstones: [],
        labourRatePerUnit: labour,
        labourUnit: 'Per Gram',
        labourWeightBasis: 'net',
        wastagePercent: 0,
        otherCharges,
        labourChargeType: 'AMOUNT_GLOBAL',
        wastageCode: '',
      },
      exact: Math.floor((milligrams * k) / 10000000) + 1 + otherCharges,
    };
  }
}

/** One realistic price's pricingMath inputs; one in ten is an exact .50 MRP. */
function realisticInputs(rnd) {
  if (rnd() < 0.1) return tieInputs(rnd).inputs;

  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const fixed = (lo, hi, dp) => Number((lo + rnd() * (hi - lo)).toFixed(dp));

  const netWt = fixed(0.1, 150, 3);
  const karat = pick([9, 10, 14, 15, 18, 20, 21, 22, 23, 24]);
  // The shop's gold rows usually hold the karat (24K never does, nor 23K,
  // 21K, 15K or 10K: they fall back to karat/24); now and then they are
  // missing.
  const karatPurityPercent = rnd() < 0.85 ? (KARAT_PURITY[karat] || 0) : 0;
  const customPurityPercent = rnd() < 0.15
    ? pick([fixed(30, 100, 2), 91.6, 99.9, 75, 58.33, 105, -2])
    : null;
  // Cash and RTGS are whole rupees (half-up upstream); a stale cache entry
  // can still carry paise.
  const goldRatePer10g = rnd() < 0.9 ? Math.round(fixed(60000, 200000, 2)) : fixed(60000, 200000, 2);

  // A stone weight is in carats, or in grams when the tag printed it so
  // (colour stones often are); the unit is left out as often as not.
  const unitFor = (gramShare) => {
    const roll = rnd();
    if (roll < gramShare) return { unit: 'g' };
    if (roll < 0.5) return { unit: 'ct' };
    return {};
  };
  const stoneCount = Math.floor(rnd() * 31);
  const diamondCount = Math.floor(rnd() * (stoneCount + 1));
  const diamonds = Array.from({ length: diamondCount }, () => ({
    weight: fixed(0.001, 5, 3),
    rate: rnd() < 0.7 ? Math.round(fixed(10000, 200000, 0)) : fixed(10000, 200000, 2),
    discountPercent: pick([0, 0, 0, 5, 10, 12.5, 15, 20, 33.33, 100, 120, -5]),
    ...unitFor(0.05),
  }));
  const colorstones = Array.from({ length: stoneCount - diamondCount }, () => ({
    weight: fixed(0.001, 5, 3),
    rate: rnd() < 0.7 ? Math.round(fixed(500, 50000, 0)) : fixed(500, 50000, 2),
    ...unitFor(0.25),
  }));
  const stoneGrams = [...diamonds, ...colorstones]
    .reduce((sum, stone) => sum + (stone.unit === 'g' ? stone.weight : stone.weight * 0.2), 0);
  const grossWt = rnd() < 0.1 ? 0 : Number((netWt + stoneGrams + rnd() * 2).toFixed(3));

  // 'Per 10 Gram' divides the rate by ten, 'Percent' is a share of the gold
  // amount, and every other unit is weight x rate.
  const labour = pick([
    () => ({ labourUnit: 'Per Gram', labourWeightBasis: 'net', labourRatePerUnit: fixed(0, 3000, 2), labourChargeType: 'AMOUNT_GLOBAL' }),
    () => ({ labourUnit: 'Per Gram', labourWeightBasis: 'gross', labourRatePerUnit: fixed(0, 3000, 2), labourChargeType: 'AMOUNT_MANUAL' }),
    () => ({ labourUnit: 'Per 10 Gram', labourWeightBasis: pick(['net', 'gross']), labourRatePerUnit: fixed(0, 20000, 2), labourChargeType: 'AMOUNT_GLOBAL' }),
    () => ({ labourUnit: 'Per Piece', labourWeightBasis: 'net', labourRatePerUnit: fixed(0, 5000, 0), labourChargeType: 'AMOUNT_MANUAL' }),
    () => ({ labourUnit: 'Percent', labourWeightBasis: 'net', labourRatePerUnit: fixed(0, 25, 2), labourChargeType: 'PERCENTAGE_GLOBAL' }),
    () => ({ labourUnit: 'Percent', labourWeightBasis: 'gross', labourRatePerUnit: fixed(0, 25, 2), labourChargeType: 'PERCENTAGE_MANUAL' }),
    () => ({ labourUnit: 'Per Gram', labourWeightBasis: pick(['net', 'gross']), labourRatePerUnit: fixed(0, 2000, 0), labourChargeType: 'AMOUNT_ITEM' }),
    () => ({ labourUnit: 'Fixed', labourWeightBasis: 'net', labourRatePerUnit: fixed(0, 50000, 0), labourChargeType: 'AMOUNT_MANUAL' }),
    () => ({ labourUnit: 'Per Gram', labourWeightBasis: 'net', labourRatePerUnit: 0, labourChargeType: 'NONE' }),
  ])();

  return {
    // A tag that printed only its gross weight: the net is worked out.
    netWt: rnd() < 0.08 ? 0 : netWt,
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

module.exports = { seeded, realisticInputs, tieInputs };
