/**
 * Cancelling scan work nobody is waiting for any more: a speculative analysis
 * a newer upload superseded, or an image warm-up for an upload that turned out
 * not to belong to the caller's scan.
 *
 * One error shape for all of it, so every layer can tell "cancelled on
 * purpose" from "failed": a cancelled pipeline is never retried, never logged
 * as a failure and never produces a result.
 */

const ABORT_CODE = 'SCAN_WORK_ABORTED';

const abortedError = () => {
  const error = new Error('Scan work cancelled');
  error.name = 'AbortError';
  error.code = ABORT_CODE;
  return error;
};

const isAbortError = (error) => error?.code === ABORT_CODE;

const throwIfAborted = (signal) => {
  if (signal?.aborted) throw abortedError();
};

module.exports = { abortedError, isAbortError, throwIfAborted };
