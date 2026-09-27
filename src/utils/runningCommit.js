/**
 * The commit this server is running, read once at startup.
 *
 * It names the deploy on /api/v1/health, and it stamps cached rates: a rate
 * worked out by one deployment is not served by the next, whose rules may
 * differ. 'unknown' when git cannot be asked (every process then agrees on
 * that, so caching still works, it just does not turn over on a deploy).
 */
const RUNNING_COMMIT = (() => {
  try {
    return require('child_process')
      .execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim() || 'unknown';
  } catch {
    return 'unknown';
  }
})();

module.exports = { RUNNING_COMMIT };
