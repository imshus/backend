const Joi = require('joi');
const { normalizeIndianMobile } = require('../utils/phone');

/**
 * The roster's request shapes. Validated values replace what was sent (see
 * validation.middleware `validateInput`), so a phone typed as "+91 98765
 * 43210" reaches the controller as its ten digits and an MPIN with stray
 * spaces as its four.
 */

const phoneSchema = Joi.string()
  .trim()
  .custom((value, helpers) => normalizeIndianMobile(value) || helpers.error('any.invalid'))
  .messages({
    'any.invalid': 'Enter a valid 10-digit mobile number',
    'string.empty': 'Enter a valid 10-digit mobile number',
    'any.required': 'Enter the employee\'s mobile number',
  });

// Four digits, travelling as a string so a leading zero survives.
const mpinSchema = Joi.string()
  .trim()
  .pattern(/^[0-9]{4}$/)
  .messages({
    'string.base': 'MPIN must be exactly 4 digits',
    'string.pattern.base': 'MPIN must be exactly 4 digits',
    'string.empty': 'Set a 4-digit MPIN',
    'any.required': 'Set a 4-digit MPIN',
  });

const confirmMpinSchema = Joi.string()
  .trim()
  .valid(Joi.ref('mpin'))
  .messages({
    'any.only': "MPINs don't match",
    'string.base': "MPINs don't match",
    'any.required': 'Confirm the MPIN',
  });

// { permissionKey: true/false }. A null value is tolerated and dropped later,
// never read as a grant.
const permissionsSchema = Joi.object()
  .pattern(Joi.string().max(64), Joi.boolean().allow(null))
  .max(200);

const nameSchema = Joi.string().trim().min(1).max(100).messages({
  'string.empty': 'Enter the employee\'s name',
  'any.required': 'Enter the employee\'s name',
});

const designationSchema = Joi.string().trim().max(80).messages({
  'string.empty': 'Enter the employee\'s designation',
  'any.required': 'Enter the employee\'s designation',
});

// Lenient on shape: older app builds fill in a made-up address when none was
// typed, and an email was never checked before.
const emailSchema = Joi.string().trim().lowercase().max(254).allow('', null);

/**
 * POST /employees, three ways:
 *  - with an MPIN (this build): name, phone, designation, mpin and confirmMpin
 *    are all required and the employee is created at once;
 *  - with a password (builds 1.0.360/1.0.361 finishing a draft): the draft
 *    supplies whatever the body leaves out;
 *  - with neither (those builds' first step): a draft is stored.
 */
const createEmployeeSchema = Joi.object({
  name: nameSchema.when('mpin', { is: Joi.exist(), then: Joi.required() }),
  phone: phoneSchema.when('mpin', { is: Joi.exist(), then: Joi.required() }),
  email: emailSchema,
  // Blank is refused only on the MPIN path; older builds may send ''.
  designation: designationSchema.when('mpin', {
    is: Joi.exist(),
    then: Joi.required(),
    otherwise: Joi.allow(''),
  }),
  permissions: permissionsSchema,
  mpin: mpinSchema,
  confirmMpin: confirmMpinSchema.when('mpin', {
    is: Joi.exist(),
    then: Joi.required(),
    otherwise: Joi.forbidden(),
  }),
  password: Joi.string().min(1).max(128),
})
  .oxor('mpin', 'password')
  .messages({ 'object.oxor': 'Send an MPIN or a password, not both' });

const updateEmployeeSchema = Joi.object({
  name: nameSchema,
  phone: phoneSchema,
  email: emailSchema,
  designation: designationSchema.allow(''),
  permissions: permissionsSchema,
  isActive: Joi.boolean(),
});

const employeeMpinSchema = Joi.object({
  mpin: mpinSchema.required(),
  confirmMpin: confirmMpinSchema.required(),
});

const checkPhoneSchema = Joi.object({
  phone: phoneSchema.required(),
});

module.exports = {
  createEmployeeSchema,
  updateEmployeeSchema,
  employeeMpinSchema,
  checkPhoneSchema,
};
