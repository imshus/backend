const INPUT_COST_PER_MILLION_USD = 0.2;
const OUTPUT_COST_PER_MILLION_USD = 1.2;
const DEFAULT_ERF = 97;
const DEFAULT_KCOMP = 0.27;
const DEFAULT_ACOMP = 0;

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

  const inputCostUsd = toSix((safePromptTokens / 1_000_000) * safeInputPrice);
  const outputCostUsd = toSix((safeCompletionTokens / 1_000_000) * safeOutputPrice);
  const totalUsd = toSix(inputCostUsd + outputCostUsd);

  const lComp = toTwo(totalUsd * safeErf);
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
  calculateScanCharge,
};
