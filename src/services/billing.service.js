/**
 * What a scan costs us, and what the shop is charged for it: exactly double.
 *
 * The reader runs on OpenAI's priority (Fast mode) tier — every scan waits on
 * the answer, so the tier is the owner's choice, and its rate is what a scan
 * actually costs. gpt-6-luna on priority, short context: $0.20 per million
 * input tokens, $1.00 per million output. (Standard would be $0.10/$0.50 and
 * flex $0.05/$0.25; the backend asks for priority, so neither applies.)
 *
 * The shop pays twice that cost — the owner's margin, 28 Nov 2026:
 *
 *   costUsd  = promptTokens/1M x inputPrice + completionTokens/1M x outputPrice
 *   costInr  = costUsd x ERF            (the rupees a scan cost us)
 *   lComp    = costInr x marginMultiplier   (what the shop pays for the tokens)
 *   charge   = lComp + kComp + aComp    (kComp and aComp are 0: see below)
 *
 * kComp and aComp are the flat per-scan lines the charge used to carry (0.27
 * and 0.15). Both are 0 now, so the charge is the doubled cost alone; they are
 * still read from billing config, so a flat line can be put back without a
 * deploy. With no flat line a scan whose token usage never came back costs
 * nothing, and scanBilling.service bills it as a zero charge rather than
 * failing - no cost known, nothing to double.
 *
 * Every figure is kept on the scan's billing row, so a scan can be read back
 * to the tokens it burned: tokens, cost in dollars, cost in rupees, the
 * multiplier, and the charge each part came to.
 */

// OpenAI priority / Fast mode, gpt-6-luna, short context (<=272K).
const INPUT_COST_PER_MILLION_USD = 0.2;
const OUTPUT_COST_PER_MILLION_USD = 1.0;
const DEFAULT_ERF = 97;
// No flat per-scan line any more: a scan is charged exactly double its cost
// and nothing else (owner, 28 Nov 2026).
const DEFAULT_KCOMP = 0;
const DEFAULT_ACOMP = 0;
/** The shop pays double what the scan cost us. */
const DEFAULT_MARGIN_MULTIPLIER = 2;

const toTwo = (value) => Number(Number(value || 0).toFixed(2));
const toSix = (value) => Number(Number(value || 0).toFixed(6));

function calculateScanCharge({
  promptTokens = 0,
  completionTokens = 0,
  erf = DEFAULT_ERF,
  inputTokenPricePerMillionUsd = INPUT_COST_PER_MILLION_USD,
  outputTokenPricePerMillionUsd = OUTPUT_COST_PER_MILLION_USD,
  kComp = DEFAULT_KCOMP,
  aComp = DEFAULT_ACOMP,
  marginMultiplier = DEFAULT_MARGIN_MULTIPLIER,
}) {
  const safePromptTokens = Math.max(0, Number(promptTokens) || 0);
  const safeCompletionTokens = Math.max(0, Number(completionTokens) || 0);
  const safeErf = Number(erf) > 0 ? Number(erf) : DEFAULT_ERF;
  const safeInputPrice = Number(inputTokenPricePerMillionUsd) >= 0
    ? Number(inputTokenPricePerMillionUsd)
    : INPUT_COST_PER_MILLION_USD;
  const safeOutputPrice = Number(outputTokenPricePerMillionUsd) >= 0
    ? Number(outputTokenPricePerMillionUsd)
    : OUTPUT_COST_PER_MILLION_USD;
  const safeKComp = Number(kComp) >= 0 ? Number(kComp) : DEFAULT_KCOMP;
  const safeAComp = Number(aComp) >= 0 ? Number(aComp) : DEFAULT_ACOMP;
  // A missing or nonsensical multiplier bills at cost rather than free: a
  // config written before this field existed still charges the margin.
  const safeMargin = Number(marginMultiplier) > 0
    ? Number(marginMultiplier)
    : DEFAULT_MARGIN_MULTIPLIER;

  const inputCostUsd = toSix((safePromptTokens / 1_000_000) * safeInputPrice);
  const outputCostUsd = toSix((safeCompletionTokens / 1_000_000) * safeOutputPrice);
  const totalUsd = toSix(inputCostUsd + outputCostUsd);

  // The cost itself, in rupees, before any margin — what the scan was worth to
  // run. Rounded only for the record; lComp is worked out from the full value,
  // so doubling cannot be thrown off by a rounded paisa.
  const costInr = toTwo(totalUsd * safeErf);
  const lComp = toTwo(totalUsd * safeErf * safeMargin);
  const computedKComp = toTwo(safeKComp);
  const computedAComp = toTwo(safeAComp);
  const totalScanCharge = toTwo(lComp + computedKComp + computedAComp);

  return {
    promptTokens: safePromptTokens,
    completionTokens: safeCompletionTokens,
    inputCostUsd,
    outputCostUsd,
    totalUsd,
    erf: safeErf,
    costInr,
    marginMultiplier: safeMargin,
    lComp,
    kComp: computedKComp,
    aComp: computedAComp,
    totalScanCharge,
  };
}

module.exports = {
  INPUT_COST_PER_MILLION_USD,
  OUTPUT_COST_PER_MILLION_USD,
  DEFAULT_ERF,
  DEFAULT_KCOMP,
  DEFAULT_ACOMP,
  DEFAULT_MARGIN_MULTIPLIER,
  calculateScanCharge,
};
