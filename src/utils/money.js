/**
 * Money arithmetic for figures that are printed or billed: commercial
 * HALF-UP rounding (a tie goes away from zero), computed exactly.
 *
 * A binary float cannot hold most decimal amounts, so a figure that is
 * exactly x.xx5 on paper usually arrives a hair below the tie
 * (4096.11 / 2 is 2048.0549999...) or a hair above it, and
 * Math.round(x * 100) / 100 then rounds it down in some cases and up in
 * others. Every helper here first snaps the float to the decimal it stands
 * for, then rounds in whole numbers:
 *
 *  - The snap keeps six decimals below the place being rounded to. The float
 *    error on any amount this app handles is below 1e-7 of a paisa, and no
 *    real input (weights to the milligram, rates to the paisa, percentages
 *    to two places) lands within 5e-7 of a tie without being on it.
 *  - After that, rounding is integer arithmetic, so the same figures give the
 *    same paise in JS, in Python (decimal ROUND_HALF_UP on the same snapped
 *    value) or by hand.
 *
 * Amounts that are added or taxed are carried as integer paise; rupees are
 * only produced at the end, for printing.
 */

const SNAP_DECIMALS = 6;

/** |value| × 10^decimals, snapped to the decimal it stands for. */
const snappedMagnitude = (value, decimals) =>
  Number((Math.abs(value) * 10 ** decimals).toFixed(SNAP_DECIMALS));

/**
 * `value` rounded half-up to `decimals` places, e.g. 2048.055 -> 2048.06 and
 * 23607.499999999996 (23,607.50 on paper) -> 23608 at 0 places.
 */
function roundHalfUp(value, decimals = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return 0;
  const rounded = Math.floor(snappedMagnitude(n, decimals) + 0.5) / 10 ** decimals;
  return n < 0 ? -rounded : rounded;
}

/** A rupee figure as whole paise, half-up: 1851.855 -> 185186. */
function toPaise(rupees) {
  const n = Number(rupees);
  if (!Number.isFinite(n) || n === 0) return 0;
  const paise = Math.floor(snappedMagnitude(n, 2) + 0.5);
  return n < 0 ? -paise : paise;
}

/** Whole paise back to rupees, for printing (exact to the paisa). */
const paiseToRupees = (paise) => Math.round(paise) / 100;

/**
 * numerator / denominator rounded half-up, for integers. Exact for any
 * operands whose magnitude stays below 2^53.
 */
function divHalfUp(numerator, denominator) {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator === 0) {
    throw new RangeError('divHalfUp needs safe integers and a non-zero denominator');
  }
  const negative = (numerator < 0) !== (denominator < 0);
  const num = Math.abs(numerator);
  const den = Math.abs(denominator);
  const quotient = Math.floor((2 * num + den) / (2 * den));
  return negative && quotient !== 0 ? -quotient : quotient;
}

/** Whole paise rounded half-up to the rupee, still in paise: 12716072 -> 12716100. */
const roundPaiseToRupee = (paise) => divHalfUp(paise, 100) * 100;

/** A percentage as basis points (hundredths of a per cent): 3 -> 300, 1.5 -> 150. */
const toBasisPoints = (percent) => toPaise(percent);

module.exports = {
  roundHalfUp,
  toPaise,
  paiseToRupees,
  divHalfUp,
  roundPaiseToRupee,
  toBasisPoints,
};
