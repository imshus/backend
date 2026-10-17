const OtpVerification = require('../models/otpVerification.model');

const createOtpRecord = async (payload) => {
  return OtpVerification.create(payload);
};

const updateOtpRecord = async (id, update) => {
  return OtpVerification.findByIdAndUpdate(id, { $set: update }, { returnDocument: 'after' });
};

// The number's own latest code, for the checks that name no flow (sign-in,
// /auth/verify-otp, forgot User ID, sign-up's fallback). A code a shop texted
// to a number it is adding as an employee is skipped: it is read only by that
// shop's own check (findLatestByMobileFlowAndBusiness), never as proof of the
// number to anyone else, and it does not hide the number's own code either.
// The code that confirms deleting one's account (ACCOUNT_DELETE) is skipped
// the same way: it proves that deletion and never signs anyone in.
const findLatestByMobile = async (mobile) => {
  return OtpVerification.findOne({ mobile, flow: { $nin: ['EMPLOYEE_PHONE', 'ACCOUNT_DELETE'] } }).sort({ createdAt: -1 });
};

const findLatestByMobileAndFlow = async (mobile, flow) => {
  return OtpVerification.findOne({ mobile, flow }).sort({ createdAt: -1 });
};

// The latest code one shop asked for: another shop's code to the same number
// is never read in its place. A resend MSG91 refused (FAILED) was never
// delivered, so it must not hide the code the employee did receive.
const findLatestByMobileFlowAndBusiness = async (mobile, flow, businessId) => {
  return OtpVerification.findOne({ mobile, flow, businessId, status: { $ne: 'FAILED' } }).sort({ createdAt: -1 });
};

// A shop's sign-up code and the codes it later texts to employees it adds are
// both PHONE codes under its businessId; only the flow tells them apart.
const findLatestByBusinessTypeAndFlow = async (businessId, otpType, flow) => {
  return OtpVerification.findOne({ businessId, otpType, flow }).sort({ createdAt: -1 });
};

module.exports = {
  createOtpRecord,
  updateOtpRecord,
  findLatestByMobile,
  findLatestByMobileAndFlow,
  findLatestByMobileFlowAndBusiness,
  findLatestByBusinessTypeAndFlow,
};
