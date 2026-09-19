const toFiniteNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
};

const aggregateJewelleryMrp = ({
  goldAmount,
  diamondAmount,
  colorstoneAmount,
  labourAmount,
  wastageAmount,
  otherChargesAmount,
}) => {
  const normalized = {
    goldAmount: toFiniteNumber(goldAmount),
    diamondAmount: toFiniteNumber(diamondAmount),
    colorstoneAmount: toFiniteNumber(colorstoneAmount),
    labourAmount: toFiniteNumber(labourAmount),
    // Metal lost in the making, charged as gold: a shop that quotes wastage
    // instead of a making charge has it as a line of its own on the bill.
    wastageAmount: toFiniteNumber(wastageAmount),
    otherChargesAmount: toFiniteNumber(otherChargesAmount),
  };

  const subtotal =
    normalized.goldAmount +
    normalized.diamondAmount +
    normalized.colorstoneAmount +
    normalized.labourAmount +
    normalized.wastageAmount +
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
