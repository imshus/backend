const test = require('node:test');
const assert = require('node:assert/strict');

const scanService = require('../src/services/scan.service');
const redisService = require('../src/services/redis.service');

const originalGetLatestScanIdForUser = redisService.getLatestScanIdForUser;
const originalUpdateScanStatus = redisService.updateScanStatus;
const originalSetScan = redisService.setScan;
const originalSetLatestScanIdForUser = redisService.setLatestScanIdForUser;

test.after(() => {
  redisService.getLatestScanIdForUser = originalGetLatestScanIdForUser;
  redisService.updateScanStatus = originalUpdateScanStatus;
  redisService.setScan = originalSetScan;
  redisService.setLatestScanIdForUser = originalSetLatestScanIdForUser;
});

test('createScan supersedes previous scan for same user and business', async () => {
  const calls = [];

  redisService.getLatestScanIdForUser = async () => 'old-scan-1';
  redisService.updateScanStatus = async (scanId, status, data) => {
    calls.push(['updateScanStatus', scanId, status, data]);
  };
  redisService.setScan = async (scanId, data) => {
    calls.push(['setScan', scanId, data.ownerUserId, data.businessId]);
  };
  redisService.setLatestScanIdForUser = async (businessId, userId, scanId) => {
    calls.push(['setLatest', businessId, userId, scanId]);
  };

  const created = await scanService.createScan('DIAMOND', 'BOTH_SIDES', {
    userId: 'user-1',
    businessId: 'business-1',
  });

  assert.equal(created.ownerUserId, 'user-1');
  assert.equal(created.businessId, 'business-1');

  assert.equal(calls[0][0], 'updateScanStatus');
  assert.equal(calls[0][1], 'old-scan-1');
  assert.equal(calls[0][2], 'SUPERSEDED');
  assert.equal(calls[1][0], 'setScan');
  assert.equal(calls[2][0], 'setLatest');
  assert.equal(calls[2][1], 'business-1');
  assert.equal(calls[2][2], 'user-1');
  assert.equal(calls[2][3], created.scanId);
});

test('createScan does not cleanup when session context missing', async () => {
  const calls = [];

  redisService.getLatestScanIdForUser = async () => {
    calls.push(['getLatest']);
    return null;
  };
  redisService.updateScanStatus = async () => {
    calls.push(['updateScanStatus']);
  };
  redisService.setScan = async (scanId) => {
    calls.push(['setScan', scanId]);
  };
  redisService.setLatestScanIdForUser = async () => {
    calls.push(['setLatest']);
  };

  const created = await scanService.createScan('GOLD', 'SINGLE_SIDE', {});

  assert.ok(created.scanId);
  assert.deepEqual(calls, [['setScan', created.scanId]]);
});

test('createScan creates unique scanIds for repeated scan operations', async () => {
  redisService.getLatestScanIdForUser = async () => null;
  redisService.updateScanStatus = async () => {};
  redisService.setLatestScanIdForUser = async () => {};

  const storedScanIds = [];
  redisService.setScan = async (scanId) => {
    storedScanIds.push(scanId);
  };

  for (let index = 0; index < 100; index += 1) {
    const created = await scanService.createScan('DIAMOND', 'BOTH_SIDES', {
      userId: 'user-1',
      businessId: 'business-1',
    });
    assert.ok(created.scanId);
  }

  assert.equal(storedScanIds.length, 100);
  assert.equal(new Set(storedScanIds).size, 100);
});
