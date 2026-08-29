const test = require('node:test');
const assert = require('node:assert/strict');

const { assertScanAccess } = require('../src/utils/scanAccess');

test('scan access: allows same user and business', () => {
  const scan = { scanId: 's1', ownerUserId: 'u1', businessId: 'b1' };
  const session = { userId: 'u1', businessId: 'b1' };
  const result = assertScanAccess(scan, session);
  assert.equal(result.scanId, 's1');
});

test('scan access: blocks cross-user access', () => {
  const scan = { scanId: 's1', ownerUserId: 'user-a', businessId: 'b1' };
  const session = { userId: 'user-b', businessId: 'b1' };
  assert.throws(
    () => assertScanAccess(scan, session),
    (err) => err.statusCode === 403 && /user mismatch/i.test(err.message),
  );
});

test('scan access: blocks cross-business access', () => {
  const scan = { scanId: 's1', ownerUserId: 'u1', businessId: 'business-a' };
  const session = { userId: 'u1', businessId: 'business-b' };
  assert.throws(
    () => assertScanAccess(scan, session),
    (err) => err.statusCode === 403 && /business mismatch/i.test(err.message),
  );
});

test('scan access: different scans stay isolated for same user', () => {
  const session = { userId: 'u1', businessId: 'b1' };
  const scan1 = { scanId: 'scan-1', ownerUserId: 'u1', businessId: 'b1', calculation: { breakdown: { otherCharges: 120 } } };
  const scan2 = { scanId: 'scan-2', ownerUserId: 'u1', businessId: 'b1', calculation: { breakdown: { otherCharges: 0 } } };

  const result1 = assertScanAccess(scan1, session);
  const result2 = assertScanAccess(scan2, session);

  assert.equal(result1.scanId, 'scan-1');
  assert.equal(result2.scanId, 'scan-2');
  assert.equal(result1.calculation.breakdown.otherCharges, 120);
  assert.equal(result2.calculation.breakdown.otherCharges, 0);
});
