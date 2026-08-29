const OtpVerification = require('../models/otpVerification.model');

const createOtpRecord = async (payload) => {
  return OtpVerification.create(payload);
};

const updateOtpRecord = async (id, update) => {
  return OtpVerification.findByIdAndUpdate(id, { $set: update }, { returnDocument: 'after' });
};

const findLatestByMobile = async (mobile) => {
  return OtpVerification.findOne({ mobile }).sort({ createdAt: -1 });
};

const findLatestByBusinessAndType = async (businessId, otpType) => {
  return OtpVerification.findOne({ businessId, otpType }).sort({ createdAt: -1 });
};

module.exports = {
  createOtpRecord,
  updateOtpRecord,
  findLatestByMobile,
  findLatestByBusinessAndType,
};
