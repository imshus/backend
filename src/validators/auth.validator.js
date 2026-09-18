const Joi = require('joi');

const USER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const PASSWORD_MIN_LENGTH = 6;

const userIdSchema = Joi.string()
  .trim()
  .min(3)
  .max(30)
  .pattern(USER_ID_PATTERN)
  .messages({
    'string.min': 'User ID must be at least 3 characters',
    'string.max': 'User ID must be 30 characters or fewer',
    'string.pattern.base': 'User ID can only contain letters, numbers, dots, underscores, and hyphens',
  });

// The owner's credential: four digits, no more and no less. Leading zeros are
// meaningful, so it travels as a string and is never a number.
const mpinSchema = Joi.string()
  .trim()
  .pattern(/^[0-9]{4}$/)
  .messages({
    'string.pattern.base': 'MPIN must be exactly 4 digits',
    'string.empty': 'Enter your 4-digit MPIN',
    'any.required': 'Enter your 4-digit MPIN',
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
  // Optional Earn & Invite code from another business; separators tolerated.
  referralCode: Joi.string().trim().uppercase().pattern(/^[A-Z0-9 -]{4,16}$/).allow('', null).optional(),
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

const referralCodeSchema = Joi.string().trim().uppercase().pattern(/^[A-Z0-9 -]{4,16}$/).allow('', null);

const createPasswordSchema = Joi.object({
  businessId: Joi.string().required(),
  fullName: Joi.string().trim().max(120).allow('').optional(),
  referralCode: referralCodeSchema.optional(),
  password: Joi.string().min(PASSWORD_MIN_LENGTH).max(128).required(),
  confirmPassword: Joi.any().valid(Joi.ref('password')).required().messages({
    'any.only': 'Passwords do not match'
  })
});

const registerSchema = Joi.object({
  mobile: Joi.string().pattern(/^[0-9]{10}$/).required(),
  // One or the other, never neither: this build sends an MPIN, and a build
  // already on someone's phone sends a password and a User ID. Both have to
  // keep registering until the old one is gone.
  mpin: mpinSchema.optional(),
  password: Joi.string().min(PASSWORD_MIN_LENGTH).max(128).optional(),
  userId: userIdSchema.optional(),
  // The name typed on the signup form; optional so an older app still registers.
  fullName: Joi.string().trim().max(120).allow('').optional(),
  // Another jeweller's Earn & Invite code, typed at signup.
  referralCode: referralCodeSchema.optional(),
  businessDetails: Joi.object({
    businessId: Joi.string().required(),
    businessName: Joi.string().allow('').optional(),
    businessType: Joi.string().allow('').optional(),
    address: Joi.string().allow('').optional(),
  }).required(),
})
  .or('mpin', 'password')
  .messages({
    'object.missing': 'Set a 4-digit MPIN to finish creating the account',
  });

// Business sign-in takes a User ID only; the field keeps its legacy `mobile`
// name so existing clients keep working.
const loginSchema = Joi.object({
  // A phone number now, or a User ID from a build that has not updated. The
  // field keeps its name so both send the same shape.
  mobile: Joi.string().trim().min(3).max(30).required().messages({
    'any.required': 'Enter your phone number',
    'string.empty': 'Enter your phone number',
  }),
  mpin: mpinSchema.optional(),
  password: Joi.string().optional(),
})
  .or('mpin', 'password')
  .messages({
    'object.missing': 'Enter your 4-digit MPIN',
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

const resetMpinSchema = Joi.object({
  resetToken: Joi.string().trim().required(),
  mpin: mpinSchema.required(),
  confirmMpin: Joi.any().valid(Joi.ref('mpin')).required().messages({
    'any.only': "MPINs don't match",
    'any.required': 'Confirm your MPIN',
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
  resetMpinSchema,
  employeeLoginSchema,
  changePasswordSchema,
};
