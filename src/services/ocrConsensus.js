/**
 * Consensus between two independent readings of the same tag.
 *
 * Both readings are parsed model answers in the { value, confidence } field
 * shape. Fields the two agree on are kept with the higher confidence, since
 * two reads over different pixels landing on the same characters is real
 * evidence. Fields they disagree on (including a value one read found and
 * the other did not) are listed for a third, targeted look at the image; until
 * that look answers, the primary reading stays in place at low confidence so
 * the review screen marks it.
 *
 * Nothing here knows about any particular tag; it compares values field by
 * field, numerically where the field is a number.
 */

const SCALAR_FIELDS = ['serialNumber', 'packetCode', 'grossWeight', 'netWeight', 'purity', 'karat', 'labour'];
const STONE_GROUPS = ['diamonds', 'colorstones'];
const STONE_FIELDS = ['shape', 'packetCode', 'weight', 'pieces', 'rate', 'quality', 'color', 'clarity', 'type'];
const NUMERIC_FIELDS = new Set(['grossWeight', 'netWeight', 'weight', 'pieces', 'rate', 'labour']);

// Confidence ceilings. A value only one read produced, or the two reads
// contradict, must come out below the review screen's attention threshold
// (80) unless a third look confirms it.
const CONTESTED_CONFIDENCE = 60;
const SINGLE_SOURCE_CONFIDENCE = 70;
const ADJUDICATED_CONFIDENCE = 85;
const ADJUDICATED_NEW_VALUE_CONFIDENCE = 70;

const fieldText = (field) => {
  if (field == null) return '';
  if (typeof field === 'object') return String(field.value ?? '').trim();
  return String(field).trim();
};

const fieldConfidence = (field) =>
  field && typeof field === 'object' ? Number(field.confidence) || 0 : 0;

/** The comparable form of a value: numbers as numbers, text without case or separators. */
const canonical = (fieldName, value) => {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (NUMERIC_FIELDS.has(fieldName)) {
    const cleaned = text.replace(/[^0-9.%]/g, '');
    const number = Number(cleaned.replace(/%/g, ''));
    if (cleaned && Number.isFinite(number)) {
      return `${number}${cleaned.includes('%') ? '%' : ''}`;
    }
  }
  return text.toUpperCase().replace(/[\s\-_.]/g, '');
};

const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

const withConfidence = (field, ceiling) => {
  const current = fieldConfidence(field);
  return { value: fieldText(field), confidence: Math.min(current, ceiling) };
};

/**
 * Compares the primary reading with the secondary one.
 * Returns { merged, disagreements, agreements } where `merged` is a copy of
 * the primary reading with confidences adjusted, and each disagreement is
 * { path, a, b } with `path` such as "grossWeight", "diamonds[0].weight" or
 * "diamonds.count".
 */
const compareReads = (primary, secondary) => {
  const merged = clone(primary) || {};
  merged.structuredData = merged.structuredData || {};
  const sdA = merged.structuredData;
  const sdB = (secondary && secondary.structuredData) || {};
  const disagreements = [];
  let agreements = 0;

  const compareField = (holderA, holderB, fieldName, path) => {
    const a = fieldText(holderA[fieldName]);
    const b = fieldText(holderB ? holderB[fieldName] : undefined);
    if (!a && !b) return;
    const same = a && b && canonical(fieldName, a) === canonical(fieldName, b);
    if (same) {
      agreements += 1;
      holderA[fieldName] = {
        value: a,
        confidence: Math.min(100, Math.max(fieldConfidence(holderA[fieldName]), fieldConfidence(holderB[fieldName]))),
      };
      return;
    }
    if (a && !b) {
      holderA[fieldName] = withConfidence(holderA[fieldName], SINGLE_SOURCE_CONFIDENCE);
    } else if (!a && b) {
      holderA[fieldName] = withConfidence(holderB[fieldName], SINGLE_SOURCE_CONFIDENCE);
    } else {
      holderA[fieldName] = withConfidence(holderA[fieldName], CONTESTED_CONFIDENCE);
    }
    disagreements.push({ path, a, b });
  };

  for (const fieldName of SCALAR_FIELDS) {
    compareField(sdA, sdB, fieldName, fieldName);
  }

  for (const group of STONE_GROUPS) {
    const stonesA = Array.isArray(sdA[group]) ? sdA[group].filter((s) => s && typeof s === 'object') : [];
    const stonesB = Array.isArray(sdB[group]) ? sdB[group].filter((s) => s && typeof s === 'object') : [];
    sdA[group] = stonesA;
    const filledA = stonesA.filter((stone) => STONE_FIELDS.some((f) => fieldText(stone[f])));
    const filledB = stonesB.filter((stone) => STONE_FIELDS.some((f) => fieldText(stone[f])));
    if (filledA.length === 0 && filledB.length === 0) continue;
    if (filledA.length !== filledB.length) {
      // The reads split the stone lines differently; every stone field is in
      // doubt until the count is settled.
      for (const stone of stonesA) {
        for (const fieldName of STONE_FIELDS) {
          if (fieldText(stone[fieldName])) stone[fieldName] = withConfidence(stone[fieldName], CONTESTED_CONFIDENCE);
        }
      }
      disagreements.push({
        path: `${group}.count`,
        a: String(filledA.length),
        b: String(filledB.length),
        alternative: clone(filledB),
      });
      continue;
    }
    filledA.forEach((stone, index) => {
      for (const fieldName of STONE_FIELDS) {
        compareField(stone, filledB[index], fieldName, `${group}[${index}].${fieldName}`);
      }
    });
  }

  // Unknown fields: everything either read could not place, without duplicates.
  const unknownA = Array.isArray(merged.unknownFields) ? merged.unknownFields : [];
  const unknownB = Array.isArray(secondary?.unknownFields) ? secondary.unknownFields : [];
  const seen = new Set(unknownA.map((u) => canonical('', u?.detectedValue || u?.abbreviation || '')));
  for (const entry of unknownB) {
    const key = canonical('', entry?.detectedValue || entry?.abbreviation || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unknownA.push(entry);
  }
  merged.unknownFields = unknownA;

  return { merged, disagreements, agreements };
};

const parsePath = (path) => {
  const stone = /^(diamonds|colorstones)\[(\d+)\]\.(\w+)$/.exec(path);
  if (stone) return { group: stone[1], index: Number(stone[2]), field: stone[3] };
  const count = /^(diamonds|colorstones)\.count$/.exec(path);
  if (count) return { group: count[1], count: true };
  return { field: path };
};

/** Lines describing the disagreements for the adjudication request. */
const describeDisagreements = (disagreements) =>
  disagreements
    .map((d, i) => {
      const parsed = parsePath(d.path);
      if (parsed.count) {
        return `${i + 1}. ${d.path} (how many separate ${parsed.group === 'diamonds' ? 'diamond' : 'colour stone'} lines the tag prints): reading A says ${d.a}, reading B says ${d.b}`;
      }
      return `${i + 1}. ${d.path}: reading A "${d.a || '(nothing)'}", reading B "${d.b || '(nothing)'}"`;
    })
    .join('\n');

/**
 * Applies the third look's answers ({ [path]: [value, confidence] } or
 * { [path]: { value, confidence } }) to the merged reading. A confirmed value
 * (one of the two readings) is capped at 85; a third value the adjudicator
 * transcribed is capped at 70 so the review screen still points at it.
 */
const applyAdjudication = (merged, disagreements, answers) => {
  const sd = merged?.structuredData;
  if (!sd || !answers || typeof answers !== 'object') return { applied: 0 };
  let applied = 0;
  const readAnswer = (path) => {
    const raw = answers[path];
    if (raw == null) return null;
    if (Array.isArray(raw)) return { value: String(raw[0] ?? '').trim(), confidence: Number(raw[1]) || 0 };
    if (typeof raw === 'object') return { value: String(raw.value ?? '').trim(), confidence: Number(raw.confidence) || 0 };
    return { value: String(raw).trim(), confidence: 0 };
  };

  for (const d of disagreements) {
    const answer = readAnswer(d.path);
    if (!answer) continue;
    const parsed = parsePath(d.path);
    if (parsed.count) {
      const chosen = Number(answer.value.replace(/[^0-9]/g, ''));
      if (!Number.isFinite(chosen)) continue;
      if (String(chosen) === d.b && Array.isArray(d.alternative)) {
        sd[parsed.group] = d.alternative.map((stone) => {
          const out = {};
          for (const key of Object.keys(stone)) {
            out[key] = withConfidence(stone[key], ADJUDICATED_CONFIDENCE);
          }
          return out;
        });
        applied += 1;
      } else if (String(chosen) === d.a) {
        for (const stone of sd[parsed.group] || []) {
          for (const key of Object.keys(stone)) {
            if (fieldText(stone[key])) stone[key] = { value: fieldText(stone[key]), confidence: ADJUDICATED_CONFIDENCE };
          }
        }
        applied += 1;
      }
      continue;
    }
    const holder = parsed.group ? (sd[parsed.group] || [])[parsed.index] : sd;
    if (!holder) continue;
    const fieldName = parsed.field;
    const confirmed =
      answer.value !== '' &&
      (canonical(fieldName, answer.value) === canonical(fieldName, d.a) ||
        canonical(fieldName, answer.value) === canonical(fieldName, d.b));
    const ceiling = confirmed ? ADJUDICATED_CONFIDENCE : ADJUDICATED_NEW_VALUE_CONFIDENCE;
    holder[fieldName] = {
      value: answer.value,
      confidence: Math.min(answer.confidence || ceiling, ceiling),
    };
    applied += 1;
  }
  return { applied };
};

module.exports = {
  compareReads,
  applyAdjudication,
  describeDisagreements,
  canonical,
  CONTESTED_CONFIDENCE,
  SINGLE_SOURCE_CONFIDENCE,
  ADJUDICATED_CONFIDENCE,
};
