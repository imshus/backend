const sendSuccess = (res, data, statusCode = 200, additionalFields = {}) => {
  res.status(statusCode).json({
    success: true,
    data,
    ...additionalFields
  });
};

const sendSuccessNoData = (res, statusCode = 200, extraFields = {}) => {
  res.status(statusCode).json({
    ...extraFields
  });
};

const sendError = (res, message, statusCode = 500) => {
  res.status(statusCode).json({
    success: false,
    error: message,
  });
};

module.exports = {
  sendSuccess,
  sendSuccessNoData,
  sendError
};
