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

module.exports = { resolveWastage };
