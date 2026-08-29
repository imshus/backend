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

module.exports = {
  validate
};
