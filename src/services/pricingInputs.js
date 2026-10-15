/**
 * Reading a price's inputs: the karat a tag or a request names, figures off
 * a tag, stone weight units, the Masters item a tag's number belongs to, the
 * colour-stone rate row a stone matches, the labour a tag prints, and the
 * checks a /calculate body must pass.
 *
 * No database and no cache here, so all of it is tested on its own. The
 * tag-reading rules mirror the app's (utils/formulaUtils.ts, itemCatalogue.ts,
 * labourUtils.ts), so a price worked out from a reading on the server and
 * the one the app asks for from the same reading agree.
 */

const { normalizeKey } = require('./diamondRateLookup.service');
const { LABOUR_UNIT_PERCENT } = require('./pricingMath');

// ── Errors a price can fail with ─────────────────────────────────────────

/** A /calculate body that cannot be priced: answered 400 with this message. */
function invalidPricingInput(message) {
  const error = new Error(message);
  error.code = 'INVALID_PRICING_INPUT';
  error.statusCode = 400;
  error.expose = true;
  return error;
}

/**
 * No live rate to price on: neither the followed house's board MCX nor a
 * stored MCX. Answered 503 rather than priced on a made-up rate.
 */
function ratesUnavailable(detail = 'no board MCX and no stored MCX') {
  const error = new Error(
    `Live gold rates are unavailable right now (${detail}), so this piece cannot be priced. Please try again in a minute.`,
  );
  error.code = 'RATES_UNAVAILABLE';
  error.statusCode = 503;
  error.expose = true;
  return error;
}

// ── Figures off a tag ────────────────────────────────────────────────────

/**
 * The first number in a tag's text, as the app reads it (formulaUtils
 * parseNumericValue): commas allowed, a dot straight after a letter ends an
 * abbreviation ("Wt.5.43" is 5.43), a leading minus counts. Then never below
 * zero, as the app's figure() does: weights, rates and percents are not
 * negative.
 */
function readFigure(raw) {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.max(0, raw) : 0;
  const text = String(raw);
  const pattern = /\d[\d,]*(?:\.\d+)?|\.\d+/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const token = match[0];
    if (token.startsWith('.') && start > 0 && /[A-Za-z]/.test(text[start - 1])) {
      pattern.lastIndex = start + 1;
      continue;
    }
    const value = Number.parseFloat(token.replace(/,/g, ''));
    if (!Number.isFinite(value)) return 0;
    const negative = start > 0 && text[start - 1] === '-' && (start === 1 || !/[A-Za-z0-9]/.test(text[start - 2]));
    return Math.max(0, negative ? -value : value);
  }
  return 0;
}

/** A field's text, whether it arrives as a string or as { value, confidence }. */
const fieldText = (field) => {
  if (field && typeof field === 'object' && !Array.isArray(field)) return String(field.value ?? '').trim();
  if (Array.isArray(field)) return String(field[0] ?? '').trim();
  return String(field ?? '').trim();
};

// ── Karat ────────────────────────────────────────────────────────────────

/** Karats a tag may carry and the app can price (its SCANNABLE_KARATS, and 15K). */
const SCANNABLE_KARAT_NUMBERS = new Set(['24', '23', '22', '21', '20', '18', '15', '14', '10', '9']);

/** Fineness standards (per mille) and the karat each stands for. */
const FINENESS_STANDARDS = [
  [375, '9K'], [417, '10K'], [585, '14K'], [625, '15K'], [750, '18K'],
  [833, '20K'], [875, '21K'], [916, '22K'], [958, '23K'], [999, '24K'],
];
/** Parts per thousand a printed value may sit from a standard and still mean it (as the app). */
const FINENESS_TOLERANCE = 20;

/** "18K", "18 KT", "22KT916", a bare "22" → "18K" / "22K" when it is a scannable karat; else "". */
function normalizeKarat(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const withUnit = raw.match(/(\d+)\s*k(?:t)?/i);
  if (withUnit && SCANNABLE_KARAT_NUMBERS.has(withUnit[1])) return `${withUnit[1]}K`;
  const digitsOnly = raw.replace(/[^0-9]/g, '');
  if (digitsOnly.length <= 2 && SCANNABLE_KARAT_NUMBERS.has(digitsOnly)) return `${digitsOnly}K`;
  return '';
}

/** "958", "95.8", "750", "75" → the nearest standard karat within 20 parts per thousand, or "". */
function karatFromFineness(value) {
  const digits = String(value ?? '').replace(/[^0-9.]/g, '');
  if (!digits) return '';
  const parsed = Number.parseFloat(digits);
  if (!Number.isFinite(parsed) || parsed <= 0) return '';
  const perMille = parsed <= 100 ? parsed * 10 : parsed;
  if (perMille < 300 || perMille > 1000) return '';
  let closest = '';
  let distance = Number.POSITIVE_INFINITY;
  for (const [standard, karat] of FINENESS_STANDARDS) {
    const gap = Math.abs(perMille - standard);
    if (gap < distance) {
      distance = gap;
      closest = karat;
    }
  }
  return distance <= FINENESS_TOLERANCE ? closest : '';
}

/**
 * The karat a reading implies, the way the app reads it (readScannedKarat):
 * the karat field, then the purity (tunch) as a karat or a fineness, then
 * the karat field as a fineness; 14K when nothing does. Fields are read as
 * the reader stores them, { value, confidence }, or as plain strings.
 */
function resolveKaratFromReading(structuredData) {
  const data = structuredData || {};
  const karat = fieldText(data.karat);
  const purity = fieldText(data.purity);
  return (
    normalizeKarat(karat)
    || normalizeKarat(purity)
    || karatFromFineness(purity)
    || karatFromFineness(karat)
    || '14K'
  );
}

/**
 * The karat a /calculate body names in purityKarat: "22K", "22KT", 22, "22",
 * or a fineness such as "916" or "958". "" when none is sent. Any whole
 * karat from 1K to 24K is accepted (one without a gold row is priced at
 * karat/24); anything else is refused.
 */
function karatOfRequest(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw invalidPricingInput('purityKarat must be a karat such as "22K" or a fineness such as "916"');
  }
  const text = String(value).trim();
  if (!text) return '';
  const refuse = () => invalidPricingInput(
    `purityKarat "${text.slice(0, 20)}" is not a karat: send one from 1K to 24K (e.g. "22K") or a fineness such as "916"`,
  );
  let karatNumber = null;
  const withUnit = text.match(/(\d{1,2})\s*k/i);
  if (withUnit) {
    karatNumber = Number(withUnit[1]);
  } else if (/^\d{1,2}$/.test(text)) {
    karatNumber = Number(text);
  } else {
    const fromFineness = karatFromFineness(text);
    if (!fromFineness) throw refuse();
    karatNumber = Number(fromFineness.slice(0, -1));
  }
  if (!Number.isInteger(karatNumber) || karatNumber < 1 || karatNumber > 24) throw refuse();
  return `${karatNumber}K`;
}

// ── Stone weight units ───────────────────────────────────────────────────

const GRAM_WORDS = new Set(['g', 'gm', 'gms', 'gr', 'grm', 'grms', 'gram', 'grams', 'gramme', 'grammes']);
const CARAT_WORDS = new Set(['ct', 'cts', 'cr', 'crt', 'crts', 'carat', 'carats', 'karat', 'karats']);

/** "g", "GMS", "Grams" → 'g'; "ct", "CTS", "carat" → 'ct'; anything else null. */
function stoneUnitOf(raw) {
  const word = String(raw ?? '').toLowerCase().replace(/[\s.]/g, '');
  if (GRAM_WORDS.has(word)) return 'g';
  if (CARAT_WORDS.has(word)) return 'ct';
  return null;
}

/** The unit written after a stone weight's number: "0.40 g" → 'g', "1.2cts" → 'ct', "0.40" → null. */
function stoneUnitInText(text) {
  const match = String(text ?? '').match(/\d(?:[\d.,]*\d)?\s*([a-z]+)/i);
  return match ? stoneUnitOf(match[1]) : null;
}

// ── Masters: the item a tag's number names ───────────────────────────────

/** Codes compared on their letters and digits alone: "GR-1" and "gr 1" are one code. */
const codeKey = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * The saved item whose code one tag identifier is printed with, as the app's
 * findItemByCode: exact first, then ignoring spacing, punctuation and case,
 * then the longest saved code of two or more characters that the tag number
 * starts with, followed by digits (GR10286 is item GR; GRT500 is not).
 */
function findItemByCode(code, rows) {
  const wanted = String(code ?? '').trim().toUpperCase();
  if (!wanted) return null;
  const items = Array.isArray(rows) ? rows : [];
  const exact = items.find((item) => String(item?.code ?? '').toUpperCase() === wanted);
  if (exact) return exact;
  const key = codeKey(wanted);
  if (!key) return null;
  const sameKey = items.find((item) => codeKey(item?.code) === key);
  if (sameKey) return sameKey;
  let prefixed = null;
  let prefixLength = 0;
  for (const item of items) {
    const itemKey = codeKey(item?.code);
    if (itemKey.length < 2 || itemKey.length >= key.length) continue;
    if (!key.startsWith(itemKey)) continue;
    if (!/^[0-9]/.test(key.slice(itemKey.length))) continue;
    if (itemKey.length > prefixLength) {
      prefixed = item;
      prefixLength = itemKey.length;
    }
  }
  return prefixed;
}

/**
 * The saved item any of a tag's identifiers names, trying them in order, and
 * the identifier that named it; null when none does (the app's findItemOnTag).
 */
function findItemOnTag(identifiers, rows) {
  for (const raw of Array.isArray(identifiers) ? identifiers : []) {
    const code = String(raw ?? '').trim();
    if (!code) continue;
    const row = findItemByCode(code, rows);
    if (row) return { row, identifier: code };
  }
  return null;
}

// ── Colour-stone rate rows ───────────────────────────────────────────────

/**
 * The colour-stone rate row a stone matches: its packet code first (the
 * stone's own, else the tag's), as diamonds are; otherwise colour and
 * clarity, on rows without a packet code only, and only when the stone has
 * a colour or a clarity at all. A stone with neither matches nothing, so its
 * printed rate stands.
 */
function findColorstoneRateMatch(rows, { packetCode, color, clarity } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const packetKey = normalizeKey(packetCode);
  if (packetKey) {
    const packetMatch = list.find((row) => normalizeKey(row?.packetCode) === packetKey);
    if (packetMatch) return packetMatch;
  }
  const colorKey = normalizeKey(color);
  const clarityKey = normalizeKey(clarity);
  if (!colorKey && !clarityKey) return null;
  return list.find((row) => (
    !normalizeKey(row?.packetCode)
    && normalizeKey(row?.color) === colorKey
    && normalizeKey(row?.clarity) === clarityKey
  )) || null;
}

// ── Labour ───────────────────────────────────────────────────────────────

const LABOUR_UNITS = {
  'per gram': 'Per Gram',
  'per 1 gram': 'Per Gram',
  'per 10 gram': 'Per 10 Gram',
  'per 10 grams': 'Per 10 Gram',
  percent: LABOUR_UNIT_PERCENT,
  percentage: LABOUR_UNIT_PERCENT,
  '%': LABOUR_UNIT_PERCENT,
};

/** A labour unit as sent: 'Per Gram', 'Per 10 Gram' or 'Percent' (any case); null otherwise. */
const labourUnitOf = (raw) => LABOUR_UNITS[String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ')] || null;

/**
 * The labour a tag prints (structuredData.labour), as the app reads it
 * (labourUtils parseLabourFromApi): "850|Per 10 Gram"; "12%" is a percent
 * of the gold value; a plain figure above 100 is rupees per gram (per 10 g
 * when the text says so). A plain figure up to 100 could be either, and the
 * app leaves it to the shop's own labour charge; so does this (null).
 */
function parseTagLabour(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const parts = text.split('|');
  if (parts.length === 2) {
    const amount = readFigure(parts[0]);
    if (amount > 0) {
      const unit = labourUnitOf(parts[1]);
      return unit === LABOUR_UNIT_PERCENT
        ? (amount <= 100 ? { amount, unit } : null)
        : { amount, unit: unit || 'Per Gram' };
    }
  }
  const amount = readFigure(text);
  if (!(amount > 0)) return null;
  if (text.includes('%')) return amount <= 100 ? { amount, unit: LABOUR_UNIT_PERCENT } : null;
  if (amount > 100) return { amount, unit: /per\s*10\s*gram/i.test(text) ? 'Per 10 Gram' : 'Per Gram' };
  return null;
}

// ── The /calculate body ──────────────────────────────────────────────────

// Bounds no real piece reaches; past them a figure is a mistake, not a price.
const MAX_WEIGHT_GRAMS = 100000;
const MAX_STONE_WEIGHT = 100000;
const MAX_RATE = 1e9;
const MAX_AMOUNT = 1e10;

const isBlank = (value) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

const NUMERIC_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * A figure the body carries, as a number or numeric text ("1,250.50" and
 * "₹ 850" read as numbers). Blank is `blank`. Not a number, negative or
 * above `max` is refused with a message naming the field.
 */
function bodyNumber(value, name, max, blank = 0) {
  if (isBlank(value)) return blank;
  let n;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    const cleaned = value.replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
    n = NUMERIC_TEXT.test(cleaned) ? Number(cleaned) : Number.NaN;
  } else {
    throw invalidPricingInput(`${name} must be a number`);
  }
  if (!Number.isFinite(n)) throw invalidPricingInput(`${name} must be a number`);
  if (n < 0) throw invalidPricingInput(`${name} cannot be negative`);
  if (n > max) throw invalidPricingInput(`${name} cannot be more than ${max.toLocaleString('en-IN')}`);
  return n === 0 ? 0 : n;
}

function bodyStones(value, name, withDiscount) {
  if (isBlank(value)) return [];
  if (!Array.isArray(value)) throw invalidPricingInput(`${name} must be a list`);
  return value.map((row, i) => {
    const at = `${name}[${i}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw invalidPricingInput(`${at} must be an object`);
    let unit = 'ct';
    if (!isBlank(row.unit)) {
      unit = typeof row.unit === 'string' ? stoneUnitOf(row.unit) : null;
      if (!unit) throw invalidPricingInput(`${at}.unit must be "ct" (carats) or "g" (grams)`);
    }
    const stone = {
      weight: bodyNumber(row.weight, `${at}.weight`, MAX_STONE_WEIGHT),
      rate: bodyNumber(row.rate, `${at}.rate`, MAX_RATE),
    };
    if (withDiscount) stone.discountPercent = bodyNumber(row.discountPercent, `${at}.discountPercent`, 100);
    stone.unit = unit;
    return stone;
  });
}

/**
 * The /calculate body (or the input the analysis derives), checked and read
 * into numbers before anything is looked up. Throws INVALID_PRICING_INPUT
 * (400) naming the field for a wrong type, a negative figure, a purity, a
 * discount or a wastage outside 0-100, or a weight or rate past any real
 * piece. A custom purity of 0 is "not set", as the app reads it.
 */
function validateCalculationInput(input) {
  const body = input ?? {};
  if (typeof body !== 'object' || Array.isArray(body)) throw invalidPricingInput('The request body must be an object');

  const out = {
    jewelleryType: body.jewelleryType,
    netWt: bodyNumber(body.netWt, 'netWt', MAX_WEIGHT_GRAMS),
    grossWt: bodyNumber(body.grossWt, 'grossWt', MAX_WEIGHT_GRAMS),
    purityKarat: karatOfRequest(body.purityKarat),
    customPurityPercent: null,
    diamonds: bodyStones(body.diamonds, 'diamonds', true),
    colorstones: bodyStones(body.colorstones, 'colorstones', false),
    manualLabour: null,
    labourWeightBasis: null,
    wastagePercent: undefined,
    otherCharges: bodyNumber(body.otherCharges, 'otherCharges', MAX_AMOUNT),
    calculationMode: undefined,
    itemCode: '',
    tagIdentifiers: [],
  };

  const customPurity = bodyNumber(body.customPurityPercent, 'customPurityPercent', 100, null);
  out.customPurityPercent = customPurity !== null && customPurity > 0 ? customPurity : null;

  let labourUnit = null;
  if (!isBlank(body.labourChargeUnit)) {
    labourUnit = typeof body.labourChargeUnit === 'string' ? labourUnitOf(body.labourChargeUnit) : null;
    if (!labourUnit) {
      throw invalidPricingInput('labourChargeUnit must be "Per Gram", "Per 10 Gram" or "Percent" (of the gold value)');
    }
  }
  if (!isBlank(body.labourChargeAmount)) {
    const raw = body.labourChargeAmount;
    const percentSign = typeof raw === 'string' && raw.includes('%');
    const percent = percentSign || labourUnit === LABOUR_UNIT_PERCENT;
    const amount = bodyNumber(
      percentSign ? raw.replace(/%/g, '') : raw,
      'labourChargeAmount',
      percent ? 100 : MAX_RATE,
    );
    out.manualLabour = { amount, unit: percent ? LABOUR_UNIT_PERCENT : (labourUnit || 'Per Gram') };
  }
  if (!isBlank(body.labourWeightBasis)) {
    const basis = String(body.labourWeightBasis).trim().toLowerCase();
    if (basis !== 'net' && basis !== 'gross') throw invalidPricingInput('labourWeightBasis must be "net" or "gross"');
    out.labourWeightBasis = basis;
  }

  if (!isBlank(body.wastagePercent)) {
    out.wastagePercent = bodyNumber(body.wastagePercent, 'wastagePercent', 100);
  }

  if (!isBlank(body.calculationMode)) {
    const mode = String(body.calculationMode).trim().toLowerCase();
    if (mode === 'cash' || mode === 'rtgs') out.calculationMode = mode;
  }

  if (!isBlank(body.itemCode)) {
    if (typeof body.itemCode !== 'string' && typeof body.itemCode !== 'number') {
      throw invalidPricingInput('itemCode must be text');
    }
    out.itemCode = String(body.itemCode).trim();
  }
  if (!isBlank(body.tagIdentifiers)) {
    if (!Array.isArray(body.tagIdentifiers)) throw invalidPricingInput('tagIdentifiers must be a list');
    out.tagIdentifiers = body.tagIdentifiers
      .filter((value) => typeof value === 'string' || typeof value === 'number')
      .map((value) => String(value).trim())
      .filter(Boolean);
  }

  return out;
}

module.exports = {
  invalidPricingInput,
  ratesUnavailable,
  readFigure,
  fieldText,
  normalizeKarat,
  karatFromFineness,
  resolveKaratFromReading,
  karatOfRequest,
  stoneUnitOf,
  stoneUnitInText,
  findItemByCode,
  findItemOnTag,
  findColorstoneRateMatch,
  labourUnitOf,
  parseTagLabour,
  validateCalculationInput,
  MAX_WEIGHT_GRAMS,
};
