const toFiniteNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
};

const aggregateJewelleryMrp = ({
  goldAmount,
  diamondAmount,
  colorstoneAmount,
  labourAmount,
  otherChargesAmount,
}) => {
  const normalized = {
    goldAmount: toFiniteNumber(goldAmount),
    diamondAmount: toFiniteNumber(diamondAmount),
    colorstoneAmount: toFiniteNumber(colorstoneAmount),
    labourAmount: toFiniteNumber(labourAmount),
    otherChargesAmount: toFiniteNumber(otherChargesAmount),
  };

  const subtotal =
    normalized.goldAmount +
    normalized.diamondAmount +
    normalized.colorstoneAmount +
    normalized.labourAmount +
    normalized.otherChargesAmount;

  return {
    ...normalized,
    subtotal,
    finalMRP: subtotal,
  };
};

module.exports = {
  aggregateJewelleryMrp,
};
