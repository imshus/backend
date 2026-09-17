/**
 * A licence belongs to the shop's owner, not to a GST number.
 *
 * A GSTIN identifies a taxpayer: a group trading under one number may run
 * several counters, and each is its own shop with its own trial and its own
 * purchase. These tests hold the two halves of that in place — a registered
 * shop is never joined by the next person to type its GSTIN, and a licence
 * records (and can be found by) the account that holds it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Business = require('../src/models/business.model');
const OrganizationLicense = require('../src/models/organizationLicense.model');

test('the GSTIN is not unique, so one number can carry several shops', () => {
  const gst = Business.schema.path('gstNumber');
  assert.equal(gst.options.unique, undefined, 'gstNumber must not be unique');
  assert.equal(gst.options.index, true, 'it is looked up on every registration');
});

test('a licence carries the owner account and the number it signs in with', () => {
  const schema = OrganizationLicense.schema;
  assert.equal(String(schema.path('ownerUserId').instance), 'ObjectId');
  assert.equal(schema.path('ownerUserId').options.ref, 'BusinessUser');
  assert.equal(String(schema.path('ownerPhone').instance), 'String');
  // Both are searched: support is given a phone number, not a businessId.
  assert.equal(schema.path('ownerUserId').options.index, true);
  assert.equal(schema.path('ownerPhone').options.index, true);
});

test('the trial is seven days, wherever the length comes from', () => {
  // The licence's own default, for a row written before any config is read.
  assert.equal(OrganizationLicense.schema.path('trialDays').options.default, 7);
  // The billing config every trial is actually started from.
  const { DEFAULT_BILLING_CONFIG } = require('../src/services/billingConfig.service');
  assert.equal(DEFAULT_BILLING_CONFIG.trialDays, 7);
  const BillingConfig = require('../src/models/billingConfig.model');
  assert.equal(BillingConfig.schema.path('trialDays').options.default, 7);
});

test('confirming a GSTIN that already has a registered shop creates another one', async () => {
  const registrationService = require('../src/services/registration.service');

  const created = [];
  const originalFindOne = Business.findOne;
  const originalCreate = Business.create;
  const originalUpdateOne = Business.updateOne;

  // The registered shop under this GSTIN. It is only ever returned when the
  // query does not exclude registered businesses — which is the bug this test
  // guards against.
  const registered = {
    _id: new mongoose.Types.ObjectId(),
    gstNumber: '27AAAAA0000A1Z5',
    isRegistered: true,
    registrationStep: 'PASSWORD_CREATED',
  };

  try {
    Business.findOne = (filter) => {
      const excludesRegistered = JSON.stringify(filter?.isRegistered ?? null).includes('$ne');
      return Promise.resolve(excludesRegistered ? null : registered);
    };
    Business.create = (doc) => {
      created.push(doc);
      return Promise.resolve({ ...doc, _id: new mongoose.Types.ObjectId(), registrationStep: 'GST_CONFIRMED' });
    };
    Business.updateOne = async () => ({});

    const result = await registrationService.confirmGst({
      gstNumber: '27AAAAA0000A1Z5',
      legalName: 'Second Counter Jewellers',
      tradeName: 'Second Counter',
      businessType: 'Retail',
      address: 'Somewhere',
      isMock: false,
    });

    assert.equal(created.length, 1, 'a new business is created');
    assert.notEqual(result.businessId, String(registered._id), 'never the registered shop');
    assert.notEqual(result.status, 'REGISTERED');
  } finally {
    Business.findOne = originalFindOne;
    Business.create = originalCreate;
    Business.updateOne = originalUpdateOne;
  }
});

test('an unfinished registration is picked up again rather than duplicated', async () => {
  const registrationService = require('../src/services/registration.service');

  const shell = {
    _id: new mongoose.Types.ObjectId(),
    gstNumber: '27BBBBB0000B1Z5',
    isRegistered: false,
    registrationStep: 'GST_CONFIRMED',
  };

  const originalFindOne = Business.findOne;
  const originalCreate = Business.create;
  const originalUpdateOne = Business.updateOne;
  const originalUpdateMany = require('../src/models/businessUser.model').updateMany;

  let createdCount = 0;
  try {
    Business.findOne = () => Promise.resolve(shell);
    Business.create = () => {
      createdCount += 1;
      return Promise.resolve({ _id: new mongoose.Types.ObjectId() });
    };
    Business.updateOne = async () => ({});
    require('../src/models/businessUser.model').updateMany = async () => ({});

    const result = await registrationService.confirmGst({
      gstNumber: '27BBBBB0000B1Z5',
      legalName: 'Same Shop',
      tradeName: 'Same Shop',
      address: 'Somewhere',
      isMock: false,
    });

    assert.equal(createdCount, 0, 'the shell is reused');
    assert.equal(result.businessId, String(shell._id));
  } finally {
    Business.findOne = originalFindOne;
    Business.create = originalCreate;
    Business.updateOne = originalUpdateOne;
    require('../src/models/businessUser.model').updateMany = originalUpdateMany;
  }
});

test('a licence is found by the mobile number its owner signs in with', async () => {
  const licenseService = require('../src/services/license.service');
  const BusinessUser = require('../src/models/businessUser.model');

  const businessId = new mongoose.Types.ObjectId();
  const stored = {
    businessId,
    ownerPhone: '9876543210',
    licenseStatus: 'FREE_TRIAL_LICENSE',
    trialEndDate: new Date(Date.now() + 5 * 864e5),
    save: async () => {},
  };

  const originalFindOne = OrganizationLicense.findOne;
  const originalUserFindOne = BusinessUser.findOne;
  try {
    OrganizationLicense.findOne = (filter) =>
      Promise.resolve(filter?.ownerPhone === '9876543210' ? stored : null);
    BusinessUser.findOne = () => Promise.resolve(null);

    // The number as a shop would give it, with spaces and a country code.
    const found = await licenseService.findLicenseByPhone('+91 98765 43210');
    assert.equal(found?.ownerPhone, '9876543210');

    const missing = await licenseService.findLicenseByPhone('9000000000');
    assert.equal(missing, null);
  } finally {
    OrganizationLicense.findOne = originalFindOne;
    BusinessUser.findOne = originalUserFindOne;
  }
});
