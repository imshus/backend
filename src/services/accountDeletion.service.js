const BullionSource = require('../models/bullionSource.model');
const Business = require('../models/business.model');
const BusinessUser = require('../models/businessUser.model');
const ColorstoneRate = require('../models/colorstoneRate.model');
const CreditTransaction = require('../models/creditTransaction.model');
const CustomCharge = require('../models/customCharge.model');
const DashboardMetrics = require('../models/dashboardMetrics.model');
const DiamondRate = require('../models/diamondRate.model');
const Employee = require('../models/employee.model');
const FormulaConfig = require('../models/formulaConfig.model');
const GoldRate = require('../models/goldRate.model');
const GoldTaxSetting = require('../models/goldTaxSetting.model');
const Invoice = require('../models/invoice.model');
const { InvoiceCounter } = require('../models/invoiceCounter.model');
const ItemCode = require('../models/itemCode.model');
const LabourRate = require('../models/labourRate.model');
const LicenseTransaction = require('../models/licenseTransaction.model');
const OrganizationLicense = require('../models/organizationLicense.model');
const OrganizationSubscription = require('../models/organizationSubscription.model');
const OrganizationWallet = require('../models/organizationWallet.model');
const OtpVerification = require('../models/otpVerification.model');
const PaymentTransaction = require('../models/paymentTransaction.model');
const ReferralCode = require('../models/referralCode.model');
const ScanBilling = require('../models/scanBilling.model');
const Wishlist = require('../models/wishlist.model');

/**
 * Permanently deletes an account and wipes off all database resources linked to it.
 *
 * @param {Object} params
 * @param {string} params.businessId - The ID of the business/organization
 * @param {string} params.userId - The ID of the requesting user
 * @param {string} [params.role] - User role ('OWNER', 'EMP', 'SUPER')
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function deleteAccount({ businessId, userId, role }) {
  const normalizedRole = String(role || '').toUpperCase();

  // If the user is an owner or has a businessId, wipe out the business and all attached resources
  if (normalizedRole === 'OWNER' || (businessId && normalizedRole !== 'EMP')) {
    const bId = businessId;

    await Promise.all([
      BullionSource.deleteMany({ businessId: bId }),
      Business.deleteOne({ _id: bId }),
      BusinessUser.deleteMany({ businessId: bId }),
      ColorstoneRate.deleteMany({ businessId: bId }),
      CreditTransaction.deleteMany({ businessId: bId }),
      CustomCharge.deleteMany({ businessId: bId }),
      DashboardMetrics.deleteMany({ businessId: bId }),
      DiamondRate.deleteMany({ businessId: bId }),
      Employee.deleteMany({ businessId: bId }),
      FormulaConfig.deleteMany({ businessId: bId }),
      GoldRate.deleteMany({ businessId: bId }),
      GoldTaxSetting.deleteMany({ businessId: bId }),
      Invoice.deleteMany({ businessId: bId }),
      InvoiceCounter.deleteMany({ businessId: bId }),
      ItemCode.deleteMany({ businessId: bId }),
      LabourRate.deleteMany({ businessId: bId }),
      LicenseTransaction.deleteMany({ businessId: bId }),
      OrganizationLicense.deleteMany({ businessId: bId }),
      OrganizationSubscription.deleteMany({ businessId: bId }),
      OrganizationWallet.deleteMany({ businessId: bId }),
      OtpVerification.deleteMany({ businessId: bId }),
      PaymentTransaction.deleteMany({ businessId: bId }),
      ReferralCode.deleteMany({ businessId: bId }),
      ScanBilling.deleteMany({ businessId: bId }),
      Wishlist.deleteMany({ businessId: bId }),
    ]);

    return {
      success: true,
      message: 'Account and all associated resources, wallet credits, and data have been permanently deleted.',
    };
  }

  // If employee account deletion
  if (normalizedRole === 'EMP') {
    await Promise.all([
      BusinessUser.deleteOne({ _id: userId }),
      Employee.deleteOne({ _id: userId }),
      Wishlist.deleteMany({ userId }),
      ScanBilling.deleteMany({ userId }),
    ]);

    return {
      success: true,
      message: 'Employee account has been permanently deleted.',
    };
  }

  // Fallback deletion for standalone user record
  if (userId) {
    const user = await BusinessUser.findById(userId);
    if (user) {
      if (user.businessId) {
        await deleteAccount({ businessId: user.businessId, userId, role: user.role });
      } else {
        await BusinessUser.deleteOne({ _id: userId });
      }
    }
  }

  return {
    success: true,
    message: 'Account has been permanently deleted.',
  };
}

module.exports = {
  deleteAccount,
};
