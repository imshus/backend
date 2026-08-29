const test = require('node:test');
const assert = require('node:assert/strict');

const mcxService = require('../src/services/mcx.service');
const redisService = require('../src/services/redis.service');
const GoldTaxSetting = require('../src/models/goldTaxSetting.model');
const GoldRate = require('../src/models/goldRate.model');
const SupremeChange = require('../src/models/supremeChange.model');

const rateCalculation = require('../src/services/rateCalculation.service');

const originalGetLiveMcxRate24K = mcxService.getLiveMcxRate24K;
const originalGetGoldRatesCache = redisService.getGoldRatesCache;
const originalSetGoldRatesCache = redisService.setGoldRatesCache;
const originalGetSupremeCache = redisService.getSupremeCache;
const originalFindTax = GoldTaxSetting.findOne;
const originalFindGold = GoldRate.find;
const originalFindSupreme = SupremeChange.findOne;

test.after(() => {
  mcxService.getLiveMcxRate24K = originalGetLiveMcxRate24K;
  redisService.getGoldRatesCache = originalGetGoldRatesCache;
  redisService.setGoldRatesCache = originalSetGoldRatesCache;
  redisService.getSupremeCache = originalGetSupremeCache;
  GoldTaxSetting.findOne = originalFindTax;
  GoldRate.find = originalFindGold;
  SupremeChange.findOne = originalFindSupreme;
});

test('getLiveGoldRates returns response even if cache write fails', async () => {
  mcxService.getLiveMcxRate24K = async () => 160000;
  redisService.getGoldRatesCache = async () => null;
  redisService.getSupremeCache = async () => ({ rtgsChange: 0, cashChange: 0 });
  redisService.setGoldRatesCache = async () => {
    throw new Error('READONLY You can\'t write against a read only replica.');
  };

  GoldTaxSetting.findOne = async () => ({
    mcxChange: { operation: '+', amount: 0 },
    rtgsChangeBy: 0,
    cashChangeBy: 0,
    scannerCalculationUse: 'rtgs',
  });

  GoldRate.find = async () => ([
    { _id: '1', carat: '22Kt', purity: 91.6, increaseByAmount: 0, increaseByType: 'FLAT', isHidden: false },
    { _id: '2', carat: '20Kt', purity: 85, increaseByAmount: 0, increaseByType: 'FLAT', isHidden: false },
    { _id: '3', carat: '18Kt', purity: 75, increaseByAmount: 0, increaseByType: 'FLAT', isHidden: false },
    { _id: '4', carat: '14Kt', purity: 58.5, increaseByAmount: 0, increaseByType: 'FLAT', isHidden: false },
    { _id: '5', carat: '9Kt', purity: 39, increaseByAmount: 0, increaseByType: 'FLAT', isHidden: false },
  ]);

  SupremeChange.findOne = () => ({
    sort: async () => null,
  });

  const result = await rateCalculation.getLiveGoldRates('business-1');

  assert.equal(result.mcxLiveRate, 160000);
  assert.ok(Array.isArray(result.karatRates));
  assert.equal(result.karatRates.length, 5);
});
