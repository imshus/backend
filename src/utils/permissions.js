/**
 * An employee's permissions as a plain { key: boolean } object, whether they
 * arrive as a Mongoose Map, a lean document's object or a request body.
 * Anything that is not a boolean is dropped rather than guessed at, so a
 * stray null never reads as a grant.
 */
function toPlainPermissions(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const entries = raw instanceof Map || (typeof raw.entries === 'function' && !Array.isArray(raw))
    ? Array.from(raw.entries())
    : Object.entries(raw);
  return Object.fromEntries(entries.filter(([key, value]) => typeof key === 'string' && typeof value === 'boolean'));
}

module.exports = { toPlainPermissions };
