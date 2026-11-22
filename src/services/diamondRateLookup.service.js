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

/**
 * A tag line like "Dia.1.48\550" carries a code after the weight that the
 * reader takes for the rate. When that number is a packet code in Masters ->
 * Diamond, it is the packet code (the shop's ask): it is recorded as such and
 * the misread rate dropped, so pricing and the result screen take that
 * packet's rate from the master. A number no packet code matches stays the
 * rate, as before. Diamonds that already have a packet code are left alone.
 *
 * `diamonds` are reading rows ({ value, confidence } fields); `packetCodes`
 * the codes configured in the master. Returns the rows (new objects only
 * where something changed).
 */
const promotePacketCodesFromRate = (diamonds, packetCodes) => {
  if (!Array.isArray(diamonds) || !Array.isArray(packetCodes) || packetCodes.length === 0) {
    return diamonds;
  }
  const byKey = new Map();
  for (const code of packetCodes) {
    const key = normalizeKey(code);
    if (key && !byKey.has(key)) byKey.set(key, String(code).trim());
  }
  const valueOf = (field) =>
    field && typeof field === 'object' && 'value' in field ? field.value : field;
  return diamonds.map((diamond) => {
    if (!diamond || typeof diamond !== 'object') return diamond;
    if (normalizeKey(valueOf(diamond.packetCode))) return diamond;
    const rateKey = normalizeKey(valueOf(diamond.rate));
    const code = rateKey ? byKey.get(rateKey) : undefined;
    if (!code) return diamond;
    const confidence = Number(diamond.rate?.confidence) || 0;
    return {
      ...diamond,
      packetCode: { value: code, confidence },
      rate: { value: '', confidence: 0 },
    };
  });
};

module.exports = { findDiamondRateMatch, normalizeKey, normalizeShapeKey, promotePacketCodesFromRate };
