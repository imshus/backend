const { StringDecoder } = require('string_decoder');

/**
 * Server-sent events, framed by hand for the rate board's streams.
 *
 * Lines end at \n (a trailing \r is stripped). A blank line dispatches the
 * pending event. A line starting with ':' is a comment (the server's ': ping'),
 * liveness only. 'event:' names the event; 'data:' lines join with \n.
 * Everything else ('id:', 'retry:', unknown fields) is ignored.
 *
 * Pure: no I/O. Chunks may split anywhere, inside a line or inside a
 * multi-byte character.
 */
const createSseParser = (onEvent) => {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let eventName = '';
  let dataLines = [];

  const dispatch = () => {
    // An event with no data line is dropped, as the spec does.
    if (dataLines.length) onEvent({ event: eventName || 'message', data: dataLines.join('\n') });
    eventName = '';
    dataLines = [];
  };

  const takeLine = (raw) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  };

  return {
    /** Feed one chunk (Buffer or string) as it comes off the socket. */
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let end = buffer.indexOf('\n');
      while (end !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        takeLine(line);
        end = buffer.indexOf('\n');
      }
    },
  };
};

/** Every complete event in a block of SSE text, in order. */
const parseSseText = (text) => {
  const events = [];
  createSseParser((event) => events.push(event)).push(text);
  return events;
};

/**
 * The rate payload an event carries, or null. Only an unnamed event (or one
 * named 'message') carries a snapshot; 'heartbeat' and every other name is
 * liveness only and is never read as rates. The payload must be an array of
 * sources or an object with a 'sources' array; anything else is ignored.
 */
const snapshotPayload = (event) => {
  if (!event || (event.event && event.event !== 'message')) return null;
  let payload;
  try {
    payload = JSON.parse(event.data);
  } catch (error) {
    return null;
  }
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object' && Array.isArray(payload.sources)) return payload;
  return null;
};

module.exports = {
  createSseParser,
  parseSseText,
  snapshotPayload,
};
