'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const config = require('./config');

/**
 * Opens (and lazily initialises) the SQLite database.
 *
 * The schema models four concepts:
 *   - users:        accounts identified by a phone number, with an approval
 *                   status and a role (user / admin).
 *   - lists:        shopping lists owned by a single user.
 *   - list_items:   individual items belonging to a list.
 *   - list_shares:  many-to-many collaboration links between a list and the
 *                   users it has been shared with.
 */
function createDatabase(dbPath = config.dbPath) {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      phone         TEXT NOT NULL UNIQUE,
      display_name  TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
      status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'declined')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lists (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title       TEXT NOT NULL DEFAULT '',
      color       TEXT NOT NULL DEFAULT 'default',
      archived    INTEGER NOT NULL DEFAULT 0,
      position    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS list_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id     INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      text        TEXT NOT NULL,
      checked     INTEGER NOT NULL DEFAULT 0,
      position    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS list_shares (
      list_id     INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (list_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_lists_owner ON lists(owner_id);
    CREATE INDEX IF NOT EXISTS idx_items_list ON list_items(list_id);
    CREATE INDEX IF NOT EXISTS idx_shares_user ON list_shares(user_id);
  `);

  return db;
}

// A single shared connection for the running application.
const db = createDatabase();

module.exports = db;
module.exports.createDatabase = createDatabase;
