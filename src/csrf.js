'use strict';

const crypto = require('crypto');

const config = require('./config');

/**
 * CSRF protection using the double-submit cookie pattern.
 *
 * A random token is stored in a readable (non-HttpOnly) `csrf_token` cookie.
 * Browsers automatically send the cookie, but same-origin script must also copy
 * its value into the `X-CSRF-Token` header. A cross-site attacker can trigger a
 * request with the victim's cookies but cannot read the cookie value to set the
 * matching header, so forged state-changing requests are rejected.
 *
 * This complements the SameSite=Strict session cookie for defence in depth.
 */
const CSRF_COOKIE = 'csrf_token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Ensures every client has a CSRF cookie to read. */
function ensureCsrfCookie(req, res, next) {
  if (!req.cookies || !req.cookies[CSRF_COOKIE]) {
    const token = crypto.randomBytes(32).toString('hex');
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false,
      secure: config.isProduction,
      sameSite: 'strict',
      path: '/',
    });
    // Make the freshly minted token available to downstream verification within
    // the same request.
    req.cookies = req.cookies || {};
    req.cookies[CSRF_COOKIE] = token;
  }
  next();
}

/** Rejects state-changing requests whose header does not match the cookie. */
function verifyCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }
  const cookieToken = req.cookies && req.cookies[CSRF_COOKIE];
  const headerToken = req.get('x-csrf-token');

  if (
    !cookieToken ||
    !headerToken ||
    cookieToken.length !== headerToken.length ||
    !crypto.timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken))
  ) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
  }
  return next();
}

module.exports = { ensureCsrfCookie, verifyCsrf, CSRF_COOKIE };
