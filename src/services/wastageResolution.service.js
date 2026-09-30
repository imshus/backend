/**
 * The wastage a scan carries, and the code it is shown under on Wastage.
 *
 * The tag's number is looked up in both masters. A Masters -> Wastage code it
 * matches is the scan's wastage code, and that code's percent is charged. The
 * item code is shown on Item Code only, never as a wastage code, at the
 * shop's asking; an item's own wastage percent still prices a piece whose
 * number is in no wastage code. A percent typed for this scan beats both.
 *
 * Kept apart from mrpCalculation.service so it can be tested without the
 * database and cache that service loads.
 */

const toNumber = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

function resolveWastage({ manualPercent, wastageRow, itemRow } = {}) {
  const hasManual =
    manualPercent !== undefined && manualPercent !== null && String(manualPercent).trim() !== '';
  const fromMaster = Boolean(wastageRow) && wastageRow.percent !== null && wastageRow.percent !== undefined;
  const percent = hasManual
    ? toNumber(manualPercent)
    : fromMaster
      ? toNumber(wastageRow.percent)
      : toNumber(itemRow?.wastage);
  return { percent, code: wastageRow ? String(wastageRow.code || '') : '' };
}

/** Codes compared on their letters and digits alone: "W 8", "w-8" and "W8" are one code. */
const codeKey = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * The Masters -> Wastage row any of the tag's identifiers names, trying them
 * in order (the item number the reader chose first, then each number it set
 * aside), so a wastage code printed beside an SR NO is still found. Null
 * when none is a saved wastage code.
 */
function findWastageRow(rows, identifiers) {
  const list = Array.isArray(rows) ? rows : [];
  for (const identifier of Array.isArray(identifiers) ? identifiers : []) {
    const key = codeKey(identifier);
    if (!key) continue;
    const row = list.find((candidate) => codeKey(candidate?.code) === key);
    if (row) return row;
  }
  return null;
}

module.exports = { resolveWastage, findWastageRow };
