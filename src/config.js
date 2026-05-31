'use strict';

const crypto = require('crypto');

require('dotenv').config();

/**
 * Centralised, validated application configuration.
 *
 * Reads from environment variables and provides safe defaults for local
 * development. In production the JWT secret MUST be supplied explicitly so we
 * never fall back to an ephemeral, process-local secret that would silently
 * invalidate every session on restart.
 */
const isProduction = process.env.NODE_ENV === 'production';

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  if (isProduction) {
    throw new Error(
      'JWT_SECRET must be set in production. Refusing to start with an insecure default.'
    );
  }
  // Development-only fallback. A warning is printed so the developer is aware
  // that sessions will not survive a restart.
  jwtSecret = crypto.randomBytes(48).toString('hex');
  // eslint-disable-next-line no-console
  console.warn(
    '[config] JWT_SECRET is not set; generated an ephemeral development secret. ' +
      'Set JWT_SECRET in your environment for stable sessions.'
  );
}

// PostgreSQL connection string. Railway (and most managed Postgres providers)
// expose this as DATABASE_URL. A local default keeps `npm start` working out of
// the box against a developer's local Postgres / docker-compose service.
const databaseUrl =
  process.env.DATABASE_URL ||
  '******localhost:5432/shopping';

if (!process.env.DATABASE_URL && isProduction) {
  throw new Error(
    'DATABASE_URL must be set in production. Refusing to start without a database connection string.'
  );
}

// Enable TLS for the database connection when talking to a provider that
// requires it (e.g. a public Postgres proxy). Internal Railway networking does
// not need this, so it defaults to off.
const databaseSsl =
  process.env.DATABASE_SSL === 'true' ||
  /[?&]sslmode=require/.test(databaseUrl);

const config = {
  isProduction,
  port: Number.parseInt(process.env.PORT, 10) || 3000,
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  databaseUrl,
  databaseSsl,
  adminPhone: (process.env.ADMIN_PHONE || '').trim(),
  cookieName: 'sl_token',
  bcryptRounds: 12,
};

module.exports = config;
