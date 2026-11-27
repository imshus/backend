/**
 * Every identifier the reader found on a tag, main one first: the item
 * number it chose (structuredData.serialNumber), then every other one the
 * tag prints (an SR NO beside the item code, a second code line), taken from
 * the transcript (rawText.merged).
 *
 * The app matches its Masters -> Item Code list against all of them, so an
 * item code the reader did not pick as THE number still names the piece. A
 * tag that prints SR NO 261440 and GR10286 used to be matched on 261440
 * alone, and the name stayed blank.
 *
 * The reader used to list the other identifiers in unknownFields. It no
 * longer writes that list (16 Oct 2026: every scan paid for it in output
 * time and the app never saw it), but scans stored before then carry it, so
 * it is still read.
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

// The labels the reader is told name an item (SR NO, ST NO, S.NO, SL NO,
// STYLE NO, ITEM NO, TAG NO, DESIGN NO, HUID), plus SR, SKU and CODE
// printed without NO, and the value printed after the label. Labour
// labels (LBR, MC) and weights are not identifiers and do not match.
const LABELLED_IDENTIFIER =
  /\b(?:(?:SR|SKU|CODE|HUID)(?:\.?\s*(?:NO|NUMBER)\b)?|(?:S|SL|ST|STYLE|ITEM|TAG|DESIGN)\.?\s*(?:NO|NUMBER)\b)\.?\s*[:#-]?\s*([A-Z0-9][A-Z0-9/-]*(?:\s\d{2,})?)/gi;
// An unlabelled item number at the HEAD of a line: a few letters and a
// number, as the reader is told item numbers look ("PSE 1086", "GR10286"),
// optionally with a suffix ("GR10286/A"). The rest of the line may carry
// anything — a tag prints "GR10286 22K GOLD" as readily as the code alone,
// and requiring the code to sit alone was losing those (27 Nov 2026).
// It must OPEN the line, so a figure further along ("GR WT 8.208", where
// the digits do not follow the letters) is never mistaken for one.
const CODE_LINE = /^\s*([A-Z]{1,4}\s?\d{3,}[A-Z]?(?:[/-][A-Z0-9]{1,4})?)(?![0-9])/i;
// Letters that label an amount, a weight or a purity rather than an item
// ("LBR 1338" is labour, "GOLD 916" is purity), or an identifier label the
// labelled pattern above has already read ("SR 838338"). Only words that
// are themselves printed immediately before a number need listing; GR and
// the other weight prefixes cannot match, since a weight prints its label
// ("GR WT") between the letters and the figure.
const NOT_A_CODE =
  /^(?:LBR|LAB|MKG|MC|MAKING|RATE|RS|MRP|AMT|TOTAL|SUB|GST|CGST|SGST|VA|PCS|PC|QTY|HM|BIS|KT|K|GOLD|FINE|PURE|PURITY|WT|NET|GROSS|DIA|CS|STONE|WAST|WASTAGE|SR|SKU|CODE|HUID|S|SL|ST)\b/i;

const transcriptOf = (analysisResult) => {
  const raw = analysisResult?.rawText;
  if (typeof raw === 'string') return raw;
  return String(raw?.merged ?? '');
};

/** Identifiers printed in the transcript, in the order they appear. */
const identifiersInTranscript = (text) => {
  const found = [];
  for (const match of text.matchAll(LABELLED_IDENTIFIER)) {
    const value = match[1];
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 2);
    // Part of a decimal (a weight or a rate), not an identifier.
    if (/^[.,]\d/.test(after)) continue;
    if (value.length < 3 || !/\d/.test(value)) continue;
    found.push(value);
  }
  for (const line of text.split(/\r?\n/)) {
    const match = CODE_LINE.exec(line);
    if (match && !NOT_A_CODE.test(match[1])) found.push(match[1]);
  }
  return found;
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
  identifiersInTranscript(transcriptOf(analysisResult)).forEach(push);
  return out;
}

module.exports = { tagIdentifiersOf };
