const { FAQ_SECTIONS } = require('../data/faqs');
const { sendSuccess } = require('../utils/apiResponse');

/**
 * GET /faqs — the whole FAQ, both languages, in section order.
 *
 * Wrapped in an object rather than answered as a bare array: the app's
 * response unwrapper leaves an envelope alone when its data is an array, and
 * a list sent that way reads back as empty.
 */
const listFaqs = (req, res) => {
  sendSuccess(res, {
    sections: FAQ_SECTIONS,
    // What a client can ask for; the text carries both, so this is a hint
    // for the picker rather than a filter.
    languages: ['en', 'hi'],
  });
};

module.exports = { listFaqs };
