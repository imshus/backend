const { sendError } = require('../utils/apiResponse');

const errorHandler = (err, req, res, next) => {
  console.error(err);
  
  const errorMapping = {
    'BUSINESS_ALREADY_REGISTERED': { status: 409, msg: 'This GST number is already registered. Please login.' },
    'INVALID_GST_NUMBER': { status: 400, msg: 'The provided GST number is invalid.' },
    'OTP_EXPIRED': { status: 400, msg: 'The OTP has expired or is invalid.' },
    'OTP_INVALID': { status: 400, msg: 'The OTP provided is incorrect.' },
    'OTP_NOT_FOUND': { status: 404, msg: 'No OTP found for this mobile number.' },
    'OTP_LIMIT_EXCEEDED': { status: 429, msg: 'You have exceeded the maximum number of OTP attempts.' },
    'RESEND_TIMEOUT': { status: 429, msg: 'Please wait before requesting another OTP.' },
    'INVALID_MOBILE_NUMBER': { status: 400, msg: 'Invalid mobile number. Provide a valid 10-digit mobile.' },
    'OTP_DB_SAVE_FAILED': { status: 500, msg: 'Failed to persist OTP request.' },
    'MSG91_CONFIG_MISSING': { status: 500, msg: 'MSG91 configuration is missing in environment.' },
    'MSG91_AUTH_ERROR': { status: 502, msg: 'MSG91 rejected credentials. Check MSG91 auth key and token configuration.' },
    'MSG91_SEND_FAILED': { status: 502, msg: 'MSG91 failed to accept OTP request.' },
    'MSG91_CLIENT_ERROR': { status: 502, msg: 'MSG91 rejected OTP request due to client validation.' },
    'MSG91_SERVER_ERROR': { status: 502, msg: 'MSG91 service returned a server error.' },
    'MSG91_NETWORK_ERROR': { status: 502, msg: 'Unable to reach MSG91 service.' },
    'MSG91_TIMEOUT': { status: 504, msg: 'MSG91 request timed out.' },
    'USER_ID_ALREADY_EXISTS': { status: 409, msg: 'This User ID is already taken. Please choose another.' },
    'PHONE_ALREADY_EXISTS': { status: 409, msg: 'This phone number is already associated with an account.' },
    'REGISTRATION_SESSION_EXPIRED': { status: 410, msg: 'Registration session expired. Please verify GST again.' },
    'UNAUTHORIZED': { status: 401, msg: 'Missing or invalid authentication token.' },
    'REFRESH_TOKEN_EXPIRED': { status: 401, msg: 'Your session has expired. Please log in again.' },
    'FORBIDDEN': { status: 403, msg: 'You do not have permission to access this resource.' },
    'INVALID_PHONE_CREDENTIALS': { status: 401, msg: 'Invalid phone number or password.' },
    'INVALID_EMPLOYEE_CREDENTIALS': { status: 401, msg: 'Invalid Employee ID or password.' },
    'OCR_IMAGE_PROCESSING_FAILED': {
      status: 422,
      msg: 'Could not process the uploaded image for OCR. Please try a clearer image or another format.',
    },
    'TRIAL_REQUIRED': { status: 403, msg: 'Start your FREE Trial Today to use scanner features.' },
    'TRIAL_EXPIRED': { status: 403, msg: 'Free trial expired. Purchase application to continue scanning.' },
    'NO_CREDITS_AVAILABLE': { status: 402, msg: 'No credits available. Please add credits to continue scanning.' },
    'INSUFFICIENT_CREDITS': { status: 402, msg: 'Insufficient credits for this scan.' },
    'INVALID_CREDIT_AMOUNT': { status: 400, msg: 'Credit amount must be greater than zero.' },
    'INVALID_SCAN_CHARGE': { status: 400, msg: 'Invalid scan billing charge generated.' },
    'TRIAL_REQUIRED_FOR_MORE_EMPLOYEES': {
      status: 403,
      msg: 'Start your free trial to add more than one employee.',
    },
    'RAZORPAY_CONFIG_MISSING': { status: 500, msg: 'Razorpay configuration is missing.' },
    'INVALID_RECHARGE_AMOUNT': { status: 400, msg: 'Recharge amount must be greater than zero.' },
    'APPLICATION_ALREADY_PURCHASED': { status: 409, msg: 'Application is already purchased for this organization.' },
    'INVALID_APPLICATION_PRICE': { status: 500, msg: 'Application pricing configuration is invalid.' },
    'PAYMENT_VERIFICATION_INPUT_MISSING': { status: 400, msg: 'Payment verification input is incomplete.' },
    'PAYMENT_ORDER_NOT_FOUND': { status: 404, msg: 'Payment order was not found.' },
    'INVALID_PAYMENT_SIGNATURE': { status: 400, msg: 'Payment signature verification failed.' },
    'PAYMENT_AMOUNT_MISMATCH': { status: 400, msg: 'Payment amount mismatch detected.' },
    'PAYMENT_NOT_CAPTURED': { status: 409, msg: 'Payment is not captured yet. Please retry shortly.' },
    'WEBHOOK_EVENT_ID_MISSING': { status: 400, msg: 'Webhook event id is missing.' },
    'INVALID_WEBHOOK_SIGNATURE': { status: 400, msg: 'Webhook signature verification failed.' },
  };

  if (err?.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        error: 'UPLOAD_FILE_TOO_LARGE',
        message: 'Image is too large to upload. Please retry with a smaller image.',
      });
    }

    return res.status(400).json({
      success: false,
      error: 'UPLOAD_MULTIPART_ERROR',
      message: err.message || 'Invalid upload payload.',
    });
  }

  if (err?.message === 'UNSUPPORTED_IMAGE_FORMAT') {
    return res.status(415).json({
      success: false,
      error: 'UNSUPPORTED_IMAGE_FORMAT',
      message: 'Unsupported image format. Use JPG, PNG, WEBP, HEIC, or HEIF.',
    });
  }

  let statusCode = err.statusCode || 500;
  let errorKey = err.message || 'Internal Server Error';
  let displayMessage = errorKey;

  // Joi Validation errors
  if (err.isJoi) {
    statusCode = 400;
    errorKey = 'VALIDATION_ERROR';
    displayMessage = err.details[0].message;
  } else if (errorMapping[err.message]) {
    statusCode = errorMapping[err.message].status;
    errorKey = err.message;
    displayMessage = errorMapping[err.message].msg;
  }

  res.status(statusCode).json({
    success: false,
    error: errorKey,
    message: displayMessage
  });
};

module.exports = errorHandler;
