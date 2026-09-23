const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const accountDeletionService = require('../src/services/accountDeletion.service');
const Business = require('../src/models/business.model');
const BusinessUser = require('../src/models/businessUser.model');
const OrganizationWallet = require('../src/models/organizationWallet.model');
const Invoice = require('../src/models/invoice.model');
const GoldRate = require('../src/models/goldRate.model');
const Wishlist = require('../src/models/wishlist.model');
const ScanBilling = require('../src/models/scanBilling.model');
const Employee = require('../src/models/employee.model');
const BullionSource = require('../src/models/bullionSource.model');
const ItemCode = require('../src/models/itemCode.model');
const ReferralCode = require('../src/models/referralCode.model');

let mongoServer;

test.before(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
});

test.after(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});

test('deleteAccount in nayabackendmrp removes business, users, wallet credits, and all associated resources', async () => {
  const businessId = new mongoose.Types.ObjectId();
  const ownerUserId = new mongoose.Types.ObjectId();
  const employeeUserId = new mongoose.Types.ObjectId();

  // 1. Seed Business & BusinessUsers
  await Business.create({
    _id: businessId,
    gstNumber: '27AAAAA0000A1Z5',
    legalName: 'Naya Jewelers Pvt Ltd',
    tradeName: 'Naya Jewelers',
    businessType: 'Retailer',
    gstStatus: 'ACTIVE',
    address: '456 Diamond Street, Mumbai',
  });

  await BusinessUser.create([
    {
      _id: ownerUserId,
      businessId,
      phone: '9888888881',
      userId: 'nayaowner',
      passwordHash: 'hashedpass',
      role: 'OWNER',
    },
    {
      _id: employeeUserId,
      businessId,
      phone: '9888888882',
      userId: 'nayaemp',
      passwordHash: 'hashedpass',
      role: 'EMP',
    },
  ]);

  // 2. Seed Organization Wallet with unused credits
  await OrganizationWallet.create({
    businessId,
    creditBalance: 500.0,
    lifetimeScans: 20,
  });

  // 3. Seed BullionSource, ItemCode, ReferralCode, GoldRate, Invoice, Wishlist, ScanBilling, Employee
  await BullionSource.create({
    businessId,
    userId: ownerUserId.toString(),
    sourceName: 'Local Bullion Dealer',
  });

  await ItemCode.create({
    businessId,
    userId: ownerUserId.toString(),
    code: 'RING-01',
    description: '22K Gold Ring',
  });

  await ReferralCode.create({
    businessId,
    userId: ownerUserId.toString(),
    code: 'REF123456',
  });

  await GoldRate.create({
    businessId,
    carat: '22Kt',
    purity: 91.6,
    increaseByAmount: 50,
  });

  await Invoice.create({
    businessId,
    invoiceNumber: 'INV-2026-009',
    customerName: 'Customer Naya',
    invoiceDate: '2026-09-23',
    subtotal: 20000,
    gstRate: 3,
    gstAmount: 600,
    grandTotal: 20600,
  });

  await Wishlist.create({
    businessId,
    userId: ownerUserId.toString(),
    itemId: 'ITEM-999',
    title: 'Diamond Necklace',
    tagCode: 'TAG-999',
    totalMrp: 150000,
    scanTimestamp: '2026-09-23T12:00:00.000Z',
    snapshot: { itemType: 'NECKLACE' },
  });

  await ScanBilling.create({
    businessId,
    userId: ownerUserId.toString(),
    scanId: 'SCAN-2002',
    scanCostCredits: 2.0,
  });

  await Employee.create({
    _id: employeeUserId,
    businessId,
    phone: '9888888882',
    name: 'Naya Employee',
    passwordHash: 'hashedpass',
  });

  // Sanity check: Ensure records exist before deletion
  const preBusiness = await Business.findById(businessId);
  assert.ok(preBusiness);
  const preWallet = await OrganizationWallet.findOne({ businessId });
  assert.equal(preWallet.creditBalance, 500.0);

  // 4. Perform Permanent Account Deletion
  const result = await accountDeletionService.deleteAccount({
    businessId: businessId.toString(),
    userId: ownerUserId.toString(),
    role: 'OWNER',
  });

  assert.equal(result.success, true);

  // 5. Verify complete wipeout from database
  const postBusiness = await Business.findById(businessId);
  assert.equal(postBusiness, null);

  const postUsers = await BusinessUser.find({ businessId });
  assert.equal(postUsers.length, 0);

  const postWallet = await OrganizationWallet.findOne({ businessId });
  assert.equal(postWallet, null);

  const postBullion = await BullionSource.find({ businessId });
  assert.equal(postBullion.length, 0);

  const postItemCodes = await ItemCode.find({ businessId });
  assert.equal(postItemCodes.length, 0);

  const postReferral = await ReferralCode.find({ businessId });
  assert.equal(postReferral.length, 0);

  const postGoldRates = await GoldRate.find({ businessId });
  assert.equal(postGoldRates.length, 0);

  const postInvoices = await Invoice.find({ businessId });
  assert.equal(postInvoices.length, 0);

  const postWishlist = await Wishlist.find({ businessId });
  assert.equal(postWishlist.length, 0);

  const postScans = await ScanBilling.find({ businessId });
  assert.equal(postScans.length, 0);

  const postEmployees = await Employee.find({ businessId });
  assert.equal(postEmployees.length, 0);
});
