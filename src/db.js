'use strict';

const { Pool } = require('pg');

const config = require('./config');

/**
 * PostgreSQL data layer.
 *
 * The application runs against a dedicated PostgreSQL database (a *separate*
 * service in production, e.g. a Railway Postgres plugin reached via
 * DATABASE_URL). A single connection pool is shared across the process.
 *
 * The schema models four concepts:
 *   - users:        accounts identified by a phone number, with an approval
 *                   status and a role (user / admin).
 *   - lists:        shopping lists owned by a single user.
 *   - list_items:   individual items belonging to a list.
 *   - list_shares:  many-to-many collaboration links between a list and the
 *                   users it has been shared with.
 *
 * Integer surrogate keys use `serial` (int4) so that pg returns them as plain
 * JavaScript numbers, keeping the strict `===` id comparisons in the route
 * handlers correct.
 */

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
});

// Surface unexpected pool-level errors instead of crashing silently.
pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[db] unexpected error on idle client', err);
});

/** Runs a parameterised query and returns the full pg result. */
function query(text, params) {
  return pool.query(text, params);
}

/** Runs a query and returns the first row (or null). */
async function get(text, params) {
  const result = await pool.query(text, params);
  return result.rows[0] || null;
}

/** Runs a query and returns all rows. */
async function all(text, params) {
  const result = await pool.query(text, params);
  return result.rows;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            serial PRIMARY KEY,
    phone         text NOT NULL UNIQUE,
    display_name  text NOT NULL DEFAULT '',
    password_hash text NOT NULL,
    role          text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'declined')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS lists (
    id          serial PRIMARY KEY,
    owner_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       text NOT NULL DEFAULT '',
    color       text NOT NULL DEFAULT 'default',
    archived    integer NOT NULL DEFAULT 0,
    position    integer NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS list_items (
    id          serial PRIMARY KEY,
    list_id     integer NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    text        text NOT NULL,
    checked     integer NOT NULL DEFAULT 0,
    position    integer NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS list_shares (
    list_id     integer NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (list_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_lists_owner ON lists(owner_id);
  CREATE INDEX IF NOT EXISTS idx_items_list ON list_items(list_id);
  CREATE INDEX IF NOT EXISTS idx_shares_user ON list_shares(user_id);
`;

/**
 * Creates the schema if it does not already exist. Safe to call repeatedly and
 * must be awaited during start-up before the server accepts traffic.
 */
async function init() {
  await pool.query(SCHEMA);
}

/** Closes the pool. Primarily used by the test suite for clean shutdown. */
async function close() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  get,
  all,
  init,
  close,
};
