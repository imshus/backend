const test = require('node:test');
const assert = require('node:assert/strict');

const { aggregateJewelleryMrp } = require('../src/services/pricingAggregation.service');

/**
 * Wastage: the metal the making consumes, charged as gold.
 *
 * For the builds on pricing rules 1 and 2 it runs on the NET weight at the
 * 24K rate, the rate their invoices print on the wastage line; these figures
 * are theirs. From rules 3 the card's Wastage tile chooses net or gross and
 * the rate is the current gold rate (the 24K rate after purity): those are
 * in tests/wastageCurrentRate.test.js.
 *
 * The design's worked example bills the same 8% against the gross weight
 * (18.500 g at ₹3,790 comes to its printed ₹5,609). Rules 1 and 2 charge
 * net, and the gross figure is kept in a test below to make the difference
 * visible rather than something to rediscover later.
 */

const GROSS_WT = 18.5;
const NET_WT = 16.9;
const WASTAGE_PERCENT = 8;
const GOLD_RATE_PER_GRAM = 3790;

const wastageAmountFor = (weightGrams, percent, ratePerGram) =>
  (percent > 0 ? weightGrams * (percent / 100) : 0) * ratePerGram;

test('rules 1-2: wastage is a share of the net weight priced at the 24K rate', () => {
  const amount = wastageAmountFor(NET_WT, WASTAGE_PERCENT, GOLD_RATE_PER_GRAM);
  assert.equal(Math.round(amount), 5124);
});

test('rules 1-2: charging it on the gross weight would bill more, and they do not', () => {
  const onGross = wastageAmountFor(GROSS_WT, WASTAGE_PERCENT, GOLD_RATE_PER_GRAM);
  assert.equal(Math.round(onGross), 5609);
  assert.ok(onGross > wastageAmountFor(NET_WT, WASTAGE_PERCENT, GOLD_RATE_PER_GRAM));
});

test('no wastage on the item means no wastage line', () => {
  assert.equal(wastageAmountFor(NET_WT, 0, GOLD_RATE_PER_GRAM), 0);
});

test('the MRP carries wastage alongside gold, stones and labour', () => {
  const result = aggregateJewelleryMrp({
    goldAmount: 58685,
    diamondAmount: 0,
    colorstoneAmount: 0,
    labourAmount: 7000,
    wastageAmount: 5124,
    otherChargesAmount: 0,
  });

  assert.equal(result.wastageAmount, 5124);
  assert.equal(result.subtotal, 70809);
  assert.equal(result.finalMRP, 70809);
});

test('a missing wastage amount is nothing, not NaN', () => {
  const result = aggregateJewelleryMrp({
    goldAmount: 58685,
    diamondAmount: 0,
    colorstoneAmount: 0,
    labourAmount: 7000,
    otherChargesAmount: 0,
  });

  assert.equal(result.wastageAmount, 0);
  assert.equal(result.finalMRP, 65685);
});

test('an unusable wastage amount does not poison the total', () => {
  for (const bad of [undefined, null, '', 'eight percent', NaN, Infinity]) {
    const result = aggregateJewelleryMrp({
      goldAmount: 1000,
      diamondAmount: 0,
      colorstoneAmount: 0,
      labourAmount: 0,
      wastageAmount: bad,
      otherChargesAmount: 0,
    });
    assert.equal(result.finalMRP, 1000, `wastageAmount=${String(bad)}`);
  }
});
