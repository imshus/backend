const Joi = require('joi');

const gstVerifySchema = Joi.object({
  gstNumber: Joi.string().pattern(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/).required().messages({
    'string.pattern.base': 'INVALID_GST_NUMBER',
    'any.required': 'GST number is required'
  })
});

const gstConfirmSchema = Joi.object({
  gstNumber: Joi.string().required()
});

const contactDetailsSchema = Joi.object({
  businessId: Joi.string().required(),
  phone: Joi.string().pattern(/^[0-9]{10}$/).required(),
});

const sendOtpSchema = Joi.object({
  mobile: Joi.string().pattern(/^[0-9]{10}$/).required()
});

const verifyMobileOtpSchema = Joi.object({
  mobile: Joi.string().pattern(/^[0-9]{10}$/).required(),
  otp: Joi.string().length(6).required(),
});

const verifyOtpSchema = Joi.object({
  businessId: Joi.string().required(),
  otp: Joi.string().length(6).required()
});

const createPasswordSchema = Joi.object({
  businessId: Joi.string().required(),
  password: Joi.string().min(8).required(),
  confirmPassword: Joi.any().valid(Joi.ref('password')).required().messages({
    'any.only': 'Passwords do not match'
  })
});

const registerSchema = Joi.object({
  mobile: Joi.string().pattern(/^[0-9]{10}$/).required(),
  password: Joi.string().min(8).required(),
  businessDetails: Joi.object({
    businessId: Joi.string().required(),
    businessName: Joi.string().allow('').optional(),
    businessType: Joi.string().allow('').optional(),
    address: Joi.string().allow('').optional(),
  }).required(),
});

const loginSchema = Joi.object({
  mobile: Joi.string().pattern(/^[0-9]{10}$/).required(),
  password: Joi.string().required()
});

const loginOtpSchema = Joi.object({
  mobile: Joi.string().pattern(/^[0-9]{10}$/).required(),
  otp: Joi.string().length(6).required(),
});

const employeeLoginSchema = Joi.object({
  phone: Joi.string().pattern(/^[0-9]{10}$/).required(),
  password: Joi.string().required(),
});
const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string().min(8).required(),
});

module.exports = {
  gstVerifySchema,
  gstConfirmSchema,
  contactDetailsSchema,
  sendOtpSchema,
  verifyMobileOtpSchema,
  verifyOtpSchema,
  createPasswordSchema,
  registerSchema,
  loginSchema,
  loginOtpSchema,
  employeeLoginSchema,
  changePasswordSchema,
};
