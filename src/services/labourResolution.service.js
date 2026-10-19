/**
 * The Masters -> Labour Code row a scan carries, and the labour it charges.
 *
 * The code picked on the card is looked up first, then each identifier on
 * the tag, as the wastage codes are (wastageResolution.service): letters and
 * digits only, so "LB 03", "lb-03" and "LB03" are one code. The row's rate
 * prices the labour unless the card sends a labour figure of its own, which
 * beats it, as a typed Wastage % beats a wastage code's percent; a scan with
 * no code row is priced exactly as before (mrpCalculation.service
 * resolveLabour).
 *
 * Kept apart from mrpCalculation.service so it can be tested without the
 * database and cache that service loads.
 */

const { LABOUR_UNIT_PERCENT } = require('./pricingMath');

/** The units a labour code is saved in. */
const LABOUR_CODE_UNITS = ['Per Gram', 'Per 10 Gram', LABOUR_UNIT_PERCENT];

/** Codes compared on their letters and digits alone: "LB 03", "lb-03" and "LB03" are one code. */
const codeKey = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * The Masters -> Labour Code row any of `identifiers` names, trying them in
 * order (the code picked on the card first, then the tag's item number, then
 * each number it set aside). Null when none is a saved labour code.
 */
function findLabourRow(rows, identifiers) {
  const list = Array.isArray(rows) ? rows : [];
  for (const identifier of Array.isArray(identifiers) ? identifiers : []) {
    const key = codeKey(identifier);
    if (!key) continue;
    const row = list.find((candidate) => codeKey(candidate?.code) === key);
    if (row) return row;
  }
  return null;
}

/**
 * The labour a code row charges, { amount, unit }: rupees per gram, per
 * 10 g, or a percent of the gold value. Null when the row gives no usable
 * figure (none saved, negative, or a percent above 100), so the item's or the
 * shop's labour applies as if no code were there.
 */
function codeLabourOf(row) {
  const amount = row?.rate;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null;
  const unit = LABOUR_CODE_UNITS.includes(row?.unit) ? row.unit : 'Per Gram';
  if (unit === LABOUR_UNIT_PERCENT && amount > 100) return null;
  return { amount, unit };
}

module.exports = { LABOUR_CODE_UNITS, codeKey, findLabourRow, codeLabourOf };
