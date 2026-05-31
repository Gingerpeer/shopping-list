'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const db = require('../db');
const {
  normalizePhone,
  validatePassword,
  cleanText,
} = require('../validators');
const {
  issueToken,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
} = require('../auth');

const router = express.Router();

// Throttle authentication attempts to slow down credential-stuffing/brute force.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

function publicUser(user) {
  return {
    id: user.id,
    phone: user.phone,
    displayName: user.display_name,
    role: user.role,
    status: user.status,
  };
}

/**
 * POST /api/auth/register
 * Creates a new account. New accounts start in the `pending` state and must be
 * approved by an administrator before they can use the app. The very first
 * account becomes an auto-approved admin (bootstrap), optionally constrained to
 * a configured ADMIN_PHONE.
 */
router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone) {
      return res.status(400).json({ error: 'A valid phone number is required.' });
    }

    const pw = validatePassword(req.body.password);
    if (!pw.ok) {
      return res.status(400).json({ error: pw.error });
    }

    const displayName = cleanText(req.body.displayName, 80);

    if (await db.get('SELECT 1 FROM users WHERE phone = $1', [phone])) {
      return res
        .status(409)
        .json({ error: 'An account with this phone number already exists.' });
    }

    const { count } = await db.get('SELECT COUNT(*)::int AS count FROM users');
    const isFirstUser = count === 0;
    const adminPhoneSet = config.adminPhone !== '';
    const matchesAdminPhone =
      adminPhoneSet && normalizePhone(config.adminPhone) === phone;

    // Bootstrap rule: the first account is promoted to admin when either no
    // ADMIN_PHONE is configured, or it matches the configured admin phone.
    const isBootstrapAdmin = isFirstUser && (!adminPhoneSet || matchesAdminPhone);

    const passwordHash = await bcrypt.hash(req.body.password, config.bcryptRounds);

    const user = await db.get(
      `INSERT INTO users (phone, display_name, password_hash, role, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        phone,
        displayName,
        passwordHash,
        isBootstrapAdmin ? 'admin' : 'user',
        isBootstrapAdmin ? 'approved' : 'pending',
      ]
    );

    // Only hand out a session immediately when the account is usable.
    if (user.status === 'approved') {
      const token = issueToken(user);
      setAuthCookie(res, token);
    }

    return res.status(201).json({
      user: publicUser(user),
      message:
        user.status === 'approved'
          ? 'Account created.'
          : 'Account created and is awaiting administrator approval.',
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/auth/login
 * Authenticates with phone + password. Approved users receive a session cookie.
 * Pending/declined users are told their status without a session being issued.
 */
router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const password = req.body.password;

    // Generic error to avoid leaking which phone numbers are registered.
    const invalid = () =>
      res.status(401).json({ error: 'Invalid phone number or password.' });

    if (!phone || typeof password !== 'string') {
      return invalid();
    }

    const user = await db.get('SELECT * FROM users WHERE phone = $1', [phone]);
    if (!user) {
      // Still run a hash comparison to keep timing roughly constant.
      await bcrypt.compare(password, '$2a$12$' + 'x'.repeat(53));
      return invalid();
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return invalid();
    }

    if (user.status !== 'approved') {
      return res.status(403).json({
        error:
          user.status === 'declined'
            ? 'Your account request was declined.'
            : 'Your account is awaiting administrator approval.',
        status: user.status,
      });
    }

    const token = issueToken(user);
    setAuthCookie(res, token);
    return res.json({ user: publicUser(user) });
  } catch (err) {
    return next(err);
  }
});

/** POST /api/auth/logout */
router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

/** GET /api/auth/me - returns the current session's user. */
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

module.exports = router;
module.exports.publicUser = publicUser;
