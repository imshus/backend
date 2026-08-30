const Joi = require('joi');

const USER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const PASSWORD_MIN_LENGTH = 6;

const userIdSchema = Joi.string()
  .trim()
  .min(3)
  .max(30)
  .pattern(USER_ID_PATTERN)
  .custom((value, helpers) => {
    // Login resolves a 10-digit entry as a phone number first, so a User ID of
    // that shape could never sign its owner in.
    if (/^[0-9]{10}$/.test(value)) return helpers.error('userId.phoneShape');
    return value;
  })
  .messages({
    'string.min': 'User ID must be at least 3 characters',
    'string.max': 'User ID must be 30 characters or fewer',
    'string.pattern.base': 'User ID can only contain letters, numbers, dots, underscores, and hyphens',
    'userId.phoneShape': 'User ID cannot be a 10-digit phone number',
  });

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

// Live signup-field validation. Empty companion fields are accepted because
// the client checks phone, User ID, and password independently while typing.
const checkAvailabilitySchema = Joi.object({
  mobile: Joi.string().pattern(/^[0-9]{10}$/).allow('').optional(),
  userId: userIdSchema.allow('').optional(),
})
  .custom((value, helpers) => {
    if (!String(value.mobile || '').trim() && !String(value.userId || '').trim()) {
      return helpers.error('object.missing');
    }
    return value;
  })
  .messages({
    'object.missing': 'Enter a phone number or User ID to check',
  });

const createPasswordSchema = Joi.object({
  businessId: Joi.string().required(),
  password: Joi.string().min(PASSWORD_MIN_LENGTH).max(128).required(),
  confirmPassword: Joi.any().valid(Joi.ref('password')).required().messages({
    'any.only': 'Passwords do not match'
  })
});

const registerSchema = Joi.object({
  mobile: Joi.string().pattern(/^[0-9]{10}$/).required(),
  password: Joi.string().min(PASSWORD_MIN_LENGTH).max(128).required(),
  userId: userIdSchema.optional(),
  businessDetails: Joi.object({
    businessId: Joi.string().required(),
    businessName: Joi.string().allow('').optional(),
    businessType: Joi.string().allow('').optional(),
    address: Joi.string().allow('').optional(),
  }).required(),
});

const loginSchema = Joi.object({
  mobile: Joi.alternatives().try(
    Joi.string().pattern(/^[0-9]{10}$/),
    userIdSchema,
  ).required(),
  password: Joi.string().required()
});

const loginOtpSchema = Joi.object({
  mobile: Joi.string().pattern(/^[0-9]{10}$/).required(),
  otp: Joi.string().length(6).required(),
});

const recoveryIdentifierSchema = Joi.alternatives()
  .try(
    Joi.string().trim().pattern(/^[0-9]{10}$/),
    userIdSchema,
  )
  .required()
  .messages({
    'alternatives.match': 'Enter a valid registered phone number or User ID',
  });

const requestPasswordResetSchema = Joi.object({
  identifier: recoveryIdentifierSchema,
});

const verifyPasswordResetOtpSchema = Joi.object({
  identifier: recoveryIdentifierSchema,
  otp: Joi.string().trim().pattern(/^[0-9]{6}$/).required().messages({
    'string.pattern.base': 'Enter the 6-digit OTP',
  }),
});

const resetPasswordSchema = Joi.object({
  resetToken: Joi.string().trim().required(),
  newPassword: Joi.string().min(PASSWORD_MIN_LENGTH).max(128).required(),
  confirmPassword: Joi.any().valid(Joi.ref('newPassword')).required().messages({
    'any.only': 'Passwords do not match',
  }),
});

const employeeLoginSchema = Joi.object({
  phone: Joi.string().pattern(/^[0-9]{10}$/).required(),
  password: Joi.string().required(),
});
const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string().min(PASSWORD_MIN_LENGTH).max(128).required(),
});

module.exports = {
  gstVerifySchema,
  gstConfirmSchema,
  contactDetailsSchema,
  sendOtpSchema,
  verifyMobileOtpSchema,
  verifyOtpSchema,
  checkAvailabilitySchema,
  createPasswordSchema,
  registerSchema,
  loginSchema,
  loginOtpSchema,
  requestPasswordResetSchema,
  verifyPasswordResetOtpSchema,
  resetPasswordSchema,
  employeeLoginSchema,
  changePasswordSchema,
};
