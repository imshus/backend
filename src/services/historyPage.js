const mongoose = require('mongoose');

/**
 * One page of a Settings -> History list (tag scans, wishlist, checkouts),
 * newest first, and the cursor for the page after it.
 *
 * Paged by a cursor on (createdAt, _id) rather than by page number: lines
 * keep arriving at the top while the list is open, and a page number would
 * then show some lines twice and skip others. _id breaks ties between lines
 * written in the same millisecond, so the order is total and stable.
 *
 * Every list has an index on its filter followed by { createdAt: -1, _id: -1 }
 * (see each model), so a page reads the lines it returns and no more.
 */

const DEFAULT_LIST_LIMIT = 30;
const MAX_LIST_LIMIT = 100;

/** The ?limit a list asks for: 30 by default, 1 to 100. */
function listLimitOf(raw) {
  const limit = Number.parseInt(raw, 10);
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, limit);
}

class InvalidCursorError extends Error {
  constructor() {
    super('This list cursor is not valid. Open the list from the top again.');
    this.code = 'INVALID_CURSOR';
    this.statusCode = 400;
  }
}

/**
 * The cursor after a line: its time and id, base64url so the app treats it as
 * an opaque string and passes it back as ?before= untouched.
 */
function cursorAfter(line) {
  const at = new Date(line.createdAt).getTime();
  return Buffer.from(`${at}:${String(line._id)}`, 'utf8').toString('base64url');
}

/**
 * The time and id a cursor stands for; null for no cursor (the first page).
 * Throws InvalidCursorError (400) for one this server did not hand out.
 */
function cursorPosition(before) {
  if (before === undefined || before === null || before === '') return null;
  if (typeof before !== 'string' || before.length > 100) throw new InvalidCursorError();
  const [msText, id, extra] = Buffer.from(before, 'base64url').toString('utf8').split(':');
  const ms = /^\d{1,15}$/.test(msText || '') ? Number(msText) : NaN;
  if (extra !== undefined || !Number.isSafeInteger(ms) || !/^[a-f0-9]{24}$/i.test(id || '')) {
    throw new InvalidCursorError();
  }
  return { at: new Date(ms), id: new mongoose.Types.ObjectId(id) };
}

/**
 * The filter for the lines in `filter` (the scope: plain field conditions)
 * after a cursor: older, or as old and with a smaller id. The scope is
 * repeated in both branches of the $or, rather than set beside it, so each
 * branch is an index range of its own merged in order; beside it, the
 * planner reads the scope's lines from the newest and drops the ones before
 * the cursor one by one.
 */
function afterCursorFilter(filter, before) {
  const position = cursorPosition(before);
  if (!position) return { ...filter };
  return {
    $or: [
      { ...filter, createdAt: { $lt: position.at } },
      { ...filter, createdAt: position.at, _id: { $lt: position.id } },
    ],
  };
}

/**
 * The query for one page: `filter` (the scope) and the cursor, newest first,
 * one line more than the page so the answer knows whether another follows.
 */
function pageQuery(Model, filter, { limit, before } = {}) {
  return Model.find(afterCursorFilter(filter, before))
    .sort({ createdAt: -1, _id: -1 })
    .limit(listLimitOf(limit) + 1);
}

/**
 * Runs a page query (lean) and splits off the extra line: { lines,
 * nextCursor }, nextCursor null on the last page.
 */
async function readPage(query, { limit } = {}) {
  const size = listLimitOf(limit);
  const found = await query.lean();
  const lines = found.slice(0, size);
  const nextCursor = found.length > size && lines.length ? cursorAfter(lines[lines.length - 1]) : null;
  return { lines, nextCursor };
}

module.exports = {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  InvalidCursorError,
  listLimitOf,
  cursorAfter,
  afterCursorFilter,
  pageQuery,
  readPage,
};
