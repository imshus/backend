/**
 * Every identifier the reader found on a tag, main one first: the item
 * number it chose (structuredData.serialNumber) and each number it set aside
 * in unknownFields (an SR NO beside the item code, a second code line).
 *
 * The app matches its Masters -> Item Code list against all of them, so an
 * item code the reader did not pick as THE number still names the piece. A
 * tag that prints SR NO 261440 and GR10286 used to be matched on 261440
 * alone, and the name stayed blank.
 *
 * Values come as a string, a { value } object or a [value, confidence]
 * pair, and unknownFields as { label, value } or { abbreviation,
 * detectedValue }; all are read. Blanks and repeats (ignoring case) are
 * dropped.
 */
const readValue = (field) => {
  if (field === null || field === undefined) return '';
  if (Array.isArray(field)) return String(field[0] ?? '');
  if (typeof field === 'object') return String(field.value ?? '');
  return String(field);
};

function tagIdentifiersOf(analysisResult) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const value = String(raw ?? '').trim();
    if (!value) return;
    const key = value.toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(value);
  };

  push(readValue(analysisResult?.structuredData?.serialNumber));
  const unknown = Array.isArray(analysisResult?.unknownFields) ? analysisResult.unknownFields : [];
  for (const entry of unknown) {
    if (!entry || typeof entry !== 'object') continue;
    push(readValue(entry.value ?? entry.detectedValue));
  }
  return out;
}

module.exports = { tagIdentifiersOf };
