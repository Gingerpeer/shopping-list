'use strict';

const jwt = require('jsonwebtoken');

const config = require('./config');
const db = require('./db');

/**
 * Authentication & authorisation helpers and Express middleware.
 */

const findUserById = db.prepare(
  'SELECT id, phone, display_name, role, status FROM users WHERE id = ?'
);

/**
 * Issues a signed session token for a user. We deliberately keep the payload
 * minimal (just the id) and re-load the authoritative user record on every
 * request so that role/status changes (e.g. an admin declining a user) take
 * effect immediately rather than at token expiry.
 */
function issueToken(user) {
  return jwt.sign({ sub: user.id }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

/**
 * Reads the token from the HttpOnly cookie (preferred) or, as a fallback, from
 * an `Authorization: ****** header. Returns the decoded user record
 * or null.
 */
function userFromRequest(req) {
  let token = req.cookies ? req.cookies[config.cookieName] : null;

  if (!token) {
    const header = req.get('authorization') || '';
    if (header.startsWith('Bearer ')) {
      token = header.slice('Bearer '.length).trim();
    }
  }

  if (!token) return null;

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = findUserById.get(payload.sub);
    return user || null;
  } catch (err) {
    return null;
  }
}

/** Requires a valid session. Attaches `req.user`. */
function requireAuth(req, res, next) {
  const user = userFromRequest(req);
  if (!user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  req.user = user;
  next();
}

/** Requires a valid session AND an approved account. */
function requireApproved(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.status !== 'approved') {
      return res.status(403).json({
        error: 'Your account is not approved yet.',
        status: req.user.status,
      });
    }
    next();
  });
}

/** Requires a valid session AND the admin role. */
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Administrator access required.' });
    }
    next();
  });
}

/** Sets the session cookie with secure attributes. */
function setAuthCookie(res, token) {
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

/** Clears the session cookie. */
function clearAuthCookie(res) {
  res.clearCookie(config.cookieName, { path: '/' });
}

module.exports = {
  issueToken,
  userFromRequest,
  requireAuth,
  requireApproved,
  requireAdmin,
  setAuthCookie,
  clearAuthCookie,
};
