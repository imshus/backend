const { sendError } = require('../utils/apiResponse');

const validate = (schema) => {
  return (req, res, next) => {
    const { error } = schema.validate(req.body, { abortEarly: false });
    
    if (error) {
      const errorMessage = error.details.map((details) => details.message).join(', ');
      return sendError(res, errorMessage, 400);
    }
    
    next();
  };
};

/**
 * Validates and then uses what was validated: Joi's converted value (trimmed,
 * normalised, unknown keys dropped) is put on `req.validated`, and replaces
 * `req.body` when the body is what was checked. A refusal carries a code and
 * a sentence the app can show as it is.
 */
const validateInput = (schema, source = 'body') => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[source] ?? {}, {
      abortEarly: false,
      stripUnknown: true,
      errors: { wrap: { label: false } },
    });

    if (error) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: error.details.map((details) => details.message).join(', '),
      });
    }

    req.validated = value;
    if (source === 'body') req.body = value;
    next();
  };
};

module.exports = {
  validate,
  validateInput,
};
