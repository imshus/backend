function divider(title) {
  console.log('');
  console.log('==============================');
  console.log(title);
  console.log('==============================');
}

function summary(title, steps) {
  console.log('');
  console.log('=========================================');
  console.log(title);
  console.log('=========================================');
  for (const step of steps) {
    console.log(step);
  }
  console.log('=========================================');
  console.log('');
}

function logContext(context = {}) {
  if (context.mobile) console.log(`Mobile: ${context.mobile}`);
  if (context.timestamp) console.log(`Timestamp: ${context.timestamp}`);
  if (context.route) console.log(`Route: ${context.route}`);
  if (context.requestId) console.log(`Request ID: ${context.requestId}`);
}

function logErrorSection(title, details = {}) {
  divider(title);
  if (details.timestamp) console.log(`Timestamp: ${details.timestamp}`);
  if (details.route) console.log(`Route: ${details.route}`);
  if (details.requestId) console.log(`Request ID: ${details.requestId}`);
  if (details.mobile) console.log(`Mobile: ${details.mobile}`);
  if (details.message) console.log(`Message: ${details.message}`);
  if (details.stack) console.log(`Stack: ${details.stack}`);
  if (details.msg91Response) console.log(`MSG91 Response: ${JSON.stringify(details.msg91Response)}`);
}

module.exports = {
  divider,
  summary,
  logContext,
  logErrorSection,
};
