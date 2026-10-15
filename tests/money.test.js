/**
 * Commercial half-up rounding, computed exactly (utils/money.js).
 *
 * Every case here is a figure the old float rounding got wrong: a value that
 * is exactly on a tie on paper but sits a hair below it as a binary float, so
 * Math.round(x * 100) / 100 rounded it down.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  roundHalfUp,
  toPaise,
  paiseToRupees,
  divHalfUp,
  roundPaiseToRupee,
  toBasisPoints,
} = require('../src/utils/money');

test('a tie that a float holds just below rounds up, to the rupee and to the paisa', () => {
  // 0.284 ct × ₹87,500 less 5% is 23,607.50 exactly; the float is ...49999999.
  const diamond = 0.284 * 87500 - 0.284 * 87500 * 0.05;
  assert.ok(diamond < 23607.5, 'the float really is below the tie');
  assert.equal(roundHalfUp(diamond), 23608);
  assert.equal(Math.round(diamond), 23607, 'what the old rounding printed');

  // Labour 2.002 g × ₹750/g = 1,501.50; gold 31.250 g at 22K, ₹1,23,080/10 g.
  assert.equal(roundHalfUp(2.002 * 750), 1502);
  assert.equal(roundHalfUp(31.25 * (91.6 / 100) * (123080 / 10)), 352317);

  // A CGST half of 4,096.11: 2,048.055 is 2,048.06, not 2,048.05.
  assert.equal(roundHalfUp(4096.11 / 2, 2), 2048.06);
  assert.equal(Math.round((4096.11 / 2) * 100) / 100, 2048.05, 'what the old round2 gave');
  // And 5,223.69 / 2 = 2,611.845 -> 2,611.85.
  assert.equal(roundHalfUp(5223.69 / 2, 2), 2611.85);
});

test('a tie on a negative figure goes away from zero; other figures round to nearest', () => {
  assert.equal(roundHalfUp(-0.5), -1);
  assert.equal(roundHalfUp(-2.345, 2), -2.35);
  assert.equal(roundHalfUp(2.344, 2), 2.34);
  assert.equal(roundHalfUp(2.346, 2), 2.35);
  assert.equal(roundHalfUp(0.4999), 0);
  assert.equal(roundHalfUp(0), 0);
  assert.equal(roundHalfUp(NaN), 0);
  assert.equal(roundHalfUp(1.0005, 3), 1.001);
});

test('rupees become whole paise half-up, and come back exact', () => {
  assert.equal(toPaise(1851.855), 185186);
  assert.equal(toPaise(23607.499999999996), 2360750);
  assert.equal(toPaise(0.1 + 0.2), 30);
  assert.equal(toPaise(-1.005), -101);
  assert.equal(toPaise(undefined), 0);
  assert.equal(paiseToRupees(185186), 1851.86);
  assert.equal(toBasisPoints(3), 300);
  assert.equal(toBasisPoints(1.5), 150);
});

test('integer division rounds half-up exactly, and rupee rounding is half-up', () => {
  assert.equal(divHalfUp(5, 2), 3);
  assert.equal(divHalfUp(7, 2), 4);
  assert.equal(divHalfUp(9, 4), 2);
  assert.equal(divHalfUp(-5, 2), -3);
  assert.equal(divHalfUp(0, 7), 0);
  // 1,74,123 × 1.5%: 2,61,184.5 paise -> 2,61,185.
  assert.equal(divHalfUp(17412300 * 300, 20000), 261185);
  // ₹1,03,154.50 -> ₹1,03,155; ₹1,27,160.72 -> ₹1,27,161; ₹10.49 -> ₹10.
  assert.equal(roundPaiseToRupee(10315450), 10315500);
  assert.equal(roundPaiseToRupee(12716072), 12716100);
  assert.equal(roundPaiseToRupee(1049), 1000);
  assert.throws(() => divHalfUp(1.5, 2), RangeError);
  assert.throws(() => divHalfUp(1, 0), RangeError);
});

test('every paise tie from 0 to 2,00,000 paise / 2 rounds up', () => {
  // Odd paise halved: x.5 paise exactly, as the CGST half of an odd GST.
  for (let paise = 1; paise < 200000; paise += 2) {
    const half = paise / 200; // rupees, a float near x.xx5
    assert.equal(toPaise(half), (paise + 1) / 2, `paise ${paise}`);
  }
});
