const test = require('node:test');
const assert = require('node:assert/strict');

const { aggregateJewelleryMrp } = require('../src/services/pricingAggregation.service');

const approxEqual = (a, b, epsilon = 1e-9) => Math.abs(a - b) <= epsilon;

const scenarios = [
  {
    name: 'Gold only',
    in: { goldAmount: 10000, diamondAmount: 0, colorstoneAmount: 0, labourAmount: 0, otherChargesAmount: 0 },
  },
  {
    name: 'Gold + Labour',
    in: { goldAmount: 10000, diamondAmount: 0, colorstoneAmount: 0, labourAmount: 1200, otherChargesAmount: 0 },
  },
  {
    name: 'Gold + Diamonds',
    in: { goldAmount: 10000, diamondAmount: 3500, colorstoneAmount: 0, labourAmount: 0, otherChargesAmount: 0 },
  },
  {
    name: 'Gold + Colorstones',
    in: { goldAmount: 10000, diamondAmount: 0, colorstoneAmount: 2400, labourAmount: 0, otherChargesAmount: 0 },
  },
  {
    name: 'Gold + Diamonds + Labour',
    in: { goldAmount: 10000, diamondAmount: 3500, colorstoneAmount: 0, labourAmount: 1200, otherChargesAmount: 0 },
  },
  {
    name: 'Gold + Colorstones + Labour',
    in: { goldAmount: 10000, diamondAmount: 0, colorstoneAmount: 2400, labourAmount: 1200, otherChargesAmount: 0 },
  },
  {
    name: 'Gold + Diamonds + Colorstones + Labour',
    in: { goldAmount: 10000, diamondAmount: 3500, colorstoneAmount: 2400, labourAmount: 1200, otherChargesAmount: 0 },
  },
  {
    name: 'All components including Other Charges',
    in: { goldAmount: 10000, diamondAmount: 3500, colorstoneAmount: 2400, labourAmount: 1200, otherChargesAmount: 350 },
  },
  {
    name: 'Zero-value components',
    in: { goldAmount: 0, diamondAmount: 0, colorstoneAmount: 0, labourAmount: 0, otherChargesAmount: 0 },
  },
  {
    name: 'Decimal values preserved',
    in: { goldAmount: 12345.67, diamondAmount: 2345.89, colorstoneAmount: 111.11, labourAmount: 99.95, otherChargesAmount: 10.5 },
  },
  {
    name: 'Multiple diamonds pre-summed',
    in: {
      goldAmount: 8000,
      // e.g. (0.20*10000) + (0.10*15000*0.9)
      diamondAmount: 2000 + 1350,
      colorstoneAmount: 0,
      labourAmount: 500,
      otherChargesAmount: 0,
    },
  },
  {
    name: 'Multiple colorstones pre-summed',
    in: {
      goldAmount: 8000,
      diamondAmount: 0,
      // e.g. (0.50*2000) + (0.25*1800)
      colorstoneAmount: 1000 + 450,
      labourAmount: 500,
      otherChargesAmount: 0,
    },
  },
  {
    name: 'String numeric inputs are normalized',
    in: { goldAmount: '1000.25', diamondAmount: '500', colorstoneAmount: '100', labourAmount: '10.5', otherChargesAmount: '5' },
  },
  {
    name: 'Invalid numeric inputs fall back to zero',
    in: { goldAmount: 'abc', diamondAmount: undefined, colorstoneAmount: null, labourAmount: NaN, otherChargesAmount: '' },
  },
];

test('aggregateJewelleryMrp: finalMRP equals strict sum of all components', async (t) => {
  for (const scenario of scenarios) {
    await t.test(scenario.name, () => {
      const result = aggregateJewelleryMrp(scenario.in);
      const expected =
        Number(result.goldAmount) +
        Number(result.diamondAmount) +
        Number(result.colorstoneAmount) +
        Number(result.labourAmount) +
        Number(result.otherChargesAmount);

      assert.equal(typeof result.goldAmount, 'number');
      assert.equal(typeof result.diamondAmount, 'number');
      assert.equal(typeof result.colorstoneAmount, 'number');
      assert.equal(typeof result.labourAmount, 'number');
      assert.equal(typeof result.otherChargesAmount, 'number');
      assert.equal(typeof result.subtotal, 'number');
      assert.equal(typeof result.finalMRP, 'number');

      assert.ok(
        approxEqual(result.subtotal, expected),
        `subtotal mismatch: expected ${expected}, got ${result.subtotal}`,
      );
      assert.ok(
        approxEqual(result.finalMRP, expected),
        `finalMRP mismatch: expected ${expected}, got ${result.finalMRP}`,
      );
    });
  }
});
