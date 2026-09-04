const normalizeKey = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const normalizeShapeKey = (value) => {
  const key = normalizeKey(value);
  return key === '0' || key === 'NONE' ? '' : key;
};

/**
 * Return the most specific configured diamond-rate row identified by the
 * supplied scan fields. Empty fields in a configured row are wildcards; this
 * matches the rate form, which allows shape, color and clarity independently.
 */
const findDiamondRateMatch = (rows, { color, clarity, shape, packetCode }) => {
  const packetKey = normalizeKey(packetCode);
  if (packetKey) {
    const packetMatch = rows.find((row) => normalizeKey(row.packetCode) === packetKey);
    if (packetMatch) return packetMatch;
  }

  const requested = {
    color: normalizeKey(color),
    clarity: normalizeKey(clarity),
    shape: normalizeShapeKey(shape),
  };
  if (!requested.color && !requested.clarity && !requested.shape) return null;

  const candidates = rows
    .map((row, index) => {
      // Packet-specific rows must only be selected by their packet code.
      if (normalizeKey(row.packetCode)) return null;

      const configured = {
        color: normalizeKey(row.color),
        clarity: normalizeKey(row.clarity),
        shape: normalizeShapeKey(row.shape),
      };
      const fields = ['color', 'clarity', 'shape'].filter((field) => configured[field]);
      if (
        fields.length === 0 ||
        fields.some((field) => !requested[field] || configured[field] !== requested[field])
      ) {
        return null;
      }

      const score =
        fields.length * 100 +
        (configured.color && configured.clarity ? 20 : 0) +
        (configured.shape ? 10 : 0) +
        (configured.color ? 2 : 0) +
        (configured.clarity ? 1 : 0);
      return { row, score, index };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return candidates[0]?.row ?? null;
};

module.exports = { findDiamondRateMatch, normalizeKey, normalizeShapeKey };
