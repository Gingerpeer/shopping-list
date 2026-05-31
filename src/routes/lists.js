'use strict';

const express = require('express');

const db = require('../db');
const { requireApproved } = require('../auth');
const { cleanText, normalizePhone } = require('../validators');

const router = express.Router();

// Every endpoint here requires an approved, signed-in user.
router.use(requireApproved);

const ALLOWED_COLORS = new Set([
  'default',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'gray',
]);

// ---- Prepared statements -------------------------------------------------

const getListById = db.prepare('SELECT * FROM lists WHERE id = ?');
const getShare = db.prepare(
  'SELECT 1 FROM list_shares WHERE list_id = ? AND user_id = ?'
);
const insertList = db.prepare(
  `INSERT INTO lists (owner_id, title, color, position)
   VALUES (@owner_id, @title, @color, @position)`
);
const maxPosition = db.prepare(
  'SELECT COALESCE(MAX(position), 0) AS p FROM lists WHERE owner_id = ?'
);
const updateListStmt = db.prepare(
  `UPDATE lists
   SET title = @title, color = @color, archived = @archived,
       updated_at = datetime('now')
   WHERE id = @id`
);
const deleteListStmt = db.prepare('DELETE FROM lists WHERE id = ?');

const itemsForList = db.prepare(
  'SELECT * FROM list_items WHERE list_id = ? ORDER BY checked ASC, position ASC, id ASC'
);
const insertItem = db.prepare(
  `INSERT INTO list_items (list_id, text, position)
   VALUES (@list_id, @text, @position)`
);
const maxItemPosition = db.prepare(
  'SELECT COALESCE(MAX(position), 0) AS p FROM list_items WHERE list_id = ?'
);
const getItem = db.prepare('SELECT * FROM list_items WHERE id = ? AND list_id = ?');
const updateItemStmt = db.prepare(
  'UPDATE list_items SET text = @text, checked = @checked WHERE id = @id'
);
const deleteItemStmt = db.prepare('DELETE FROM list_items WHERE id = ?');

const sharesForList = db.prepare(
  `SELECT u.id, u.phone, u.display_name
   FROM list_shares s JOIN users u ON u.id = s.user_id
   WHERE s.list_id = ? ORDER BY u.display_name, u.phone`
);
const insertShare = db.prepare(
  'INSERT OR IGNORE INTO list_shares (list_id, user_id) VALUES (?, ?)'
);
const deleteShare = db.prepare(
  'DELETE FROM list_shares WHERE list_id = ? AND user_id = ?'
);
const findUserByPhone = db.prepare(
  "SELECT id, phone, display_name, status FROM users WHERE phone = ?"
);

const listsForUser = db.prepare(
  `SELECT DISTINCT l.* FROM lists l
   LEFT JOIN list_shares s ON s.list_id = l.id
   WHERE l.owner_id = @uid OR s.user_id = @uid
   ORDER BY l.archived ASC, l.position DESC, l.updated_at DESC`
);
const ownerOf = db.prepare(
  'SELECT id, phone, display_name FROM users WHERE id = ?'
);

// ---- Access helpers ------------------------------------------------------

/**
 * Returns 'owner', 'collaborator' or null describing how `userId` may access
 * the given list.
 */
function accessLevel(list, userId) {
  if (!list) return null;
  if (list.owner_id === userId) return 'owner';
  if (getShare.get(list.id, userId)) return 'collaborator';
  return null;
}

function serializeList(list, currentUserId) {
  const owner = ownerOf.get(list.owner_id);
  return {
    id: list.id,
    title: list.title,
    color: list.color,
    archived: !!list.archived,
    position: list.position,
    createdAt: list.created_at,
    updatedAt: list.updated_at,
    isOwner: list.owner_id === currentUserId,
    owner: owner
      ? { id: owner.id, phone: owner.phone, displayName: owner.display_name }
      : null,
    items: itemsForList.all(list.id).map((it) => ({
      id: it.id,
      text: it.text,
      checked: !!it.checked,
      position: it.position,
    })),
    collaborators: sharesForList.all(list.id).map((u) => ({
      id: u.id,
      phone: u.phone,
      displayName: u.display_name,
    })),
  };
}

/** Loads a list and verifies the current user may access it. */
function loadAccessibleList(req, res) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'Invalid list id.' });
    return null;
  }
  const list = getListById.get(id);
  const level = accessLevel(list, req.user.id);
  if (!level) {
    res.status(404).json({ error: 'List not found.' });
    return null;
  }
  return { list, level };
}

// ---- List endpoints ------------------------------------------------------

/** GET /api/lists - all lists owned by or shared with the current user. */
router.get('/', (req, res) => {
  const rows = listsForUser.all({ uid: req.user.id });
  res.json({ lists: rows.map((l) => serializeList(l, req.user.id)) });
});

/** POST /api/lists - create a new list. */
router.post('/', (req, res) => {
  const title = cleanText(req.body.title, 120);
  let color = cleanText(req.body.color, 20) || 'default';
  if (!ALLOWED_COLORS.has(color)) color = 'default';

  const position = maxPosition.get(req.user.id).p + 1;
  const info = insertList.run({
    owner_id: req.user.id,
    title,
    color,
    position,
  });

  // Optionally accept an initial set of items.
  if (Array.isArray(req.body.items)) {
    let pos = 0;
    for (const raw of req.body.items.slice(0, 200)) {
      const text = cleanText(raw && raw.text, 300);
      if (text) {
        insertItem.run({ list_id: info.lastInsertRowid, text, position: ++pos });
      }
    }
  }

  const list = getListById.get(info.lastInsertRowid);
  res.status(201).json({ list: serializeList(list, req.user.id) });
});

/** GET /api/lists/:id */
router.get('/:id', (req, res) => {
  const ctx = loadAccessibleList(req, res);
  if (!ctx) return;
  res.json({ list: serializeList(ctx.list, req.user.id) });
});

/** PATCH /api/lists/:id - update title/color/archived (owner or collaborator). */
router.patch('/:id', (req, res) => {
  const ctx = loadAccessibleList(req, res);
  if (!ctx) return;
  const { list } = ctx;

  const title =
    req.body.title !== undefined ? cleanText(req.body.title, 120) : list.title;
  let color = list.color;
  if (req.body.color !== undefined) {
    const c = cleanText(req.body.color, 20);
    color = ALLOWED_COLORS.has(c) ? c : list.color;
  }
  let archived = list.archived;
  if (req.body.archived !== undefined) {
    archived = req.body.archived ? 1 : 0;
  }

  updateListStmt.run({ id: list.id, title, color, archived });
  res.json({ list: serializeList(getListById.get(list.id), req.user.id) });
});

/** DELETE /api/lists/:id - owner only. */
router.delete('/:id', (req, res) => {
  const ctx = loadAccessibleList(req, res);
  if (!ctx) return;
  if (ctx.level !== 'owner') {
    return res.status(403).json({ error: 'Only the list owner can delete it.' });
  }
  deleteListStmt.run(ctx.list.id);
  res.json({ ok: true });
});

// ---- Item endpoints ------------------------------------------------------

/** POST /api/lists/:id/items - add an item. */
router.post('/:id/items', (req, res) => {
  const ctx = loadAccessibleList(req, res);
  if (!ctx) return;

  const text = cleanText(req.body.text, 300);
  if (!text) {
    return res.status(400).json({ error: 'Item text is required.' });
  }
  const position = maxItemPosition.get(ctx.list.id).p + 1;
  insertItem.run({ list_id: ctx.list.id, text, position });
  updateListStmt.run({
    id: ctx.list.id,
    title: ctx.list.title,
    color: ctx.list.color,
    archived: ctx.list.archived,
  });
  res.status(201).json({ list: serializeList(getListById.get(ctx.list.id), req.user.id) });
});

/** PATCH /api/lists/:id/items/:itemId - toggle/edit an item. */
router.patch('/:id/items/:itemId', (req, res) => {
  const ctx = loadAccessibleList(req, res);
  if (!ctx) return;

  const itemId = Number.parseInt(req.params.itemId, 10);
  const item = getItem.get(itemId, ctx.list.id);
  if (!item) {
    return res.status(404).json({ error: 'Item not found.' });
  }

  const text =
    req.body.text !== undefined ? cleanText(req.body.text, 300) : item.text;
  const checked =
    req.body.checked !== undefined ? (req.body.checked ? 1 : 0) : item.checked;

  if (!text) {
    return res.status(400).json({ error: 'Item text cannot be empty.' });
  }

  updateItemStmt.run({ id: itemId, text, checked });
  res.json({ list: serializeList(getListById.get(ctx.list.id), req.user.id) });
});

/** DELETE /api/lists/:id/items/:itemId */
router.delete('/:id/items/:itemId', (req, res) => {
  const ctx = loadAccessibleList(req, res);
  if (!ctx) return;

  const itemId = Number.parseInt(req.params.itemId, 10);
  const item = getItem.get(itemId, ctx.list.id);
  if (!item) {
    return res.status(404).json({ error: 'Item not found.' });
  }
  deleteItemStmt.run(itemId);
  res.json({ list: serializeList(getListById.get(ctx.list.id), req.user.id) });
});

// ---- Collaboration endpoints --------------------------------------------

/** POST /api/lists/:id/share - share with another user by phone number. */
router.post('/:id/share', (req, res) => {
  const ctx = loadAccessibleList(req, res);
  if (!ctx) return;
  if (ctx.level !== 'owner') {
    return res
      .status(403)
      .json({ error: 'Only the list owner can manage sharing.' });
  }

  const phone = normalizePhone(req.body.phone);
  if (!phone) {
    return res.status(400).json({ error: 'A valid phone number is required.' });
  }
  if (phone === req.user.phone) {
    return res.status(400).json({ error: 'You already own this list.' });
  }

  const target = findUserByPhone.get(phone);
  if (!target) {
    return res
      .status(404)
      .json({ error: 'No user with that phone number was found.' });
  }
  if (target.status !== 'approved') {
    return res
      .status(400)
      .json({ error: 'That user is not an approved member yet.' });
  }

  insertShare.run(ctx.list.id, target.id);
  res.json({ list: serializeList(getListById.get(ctx.list.id), req.user.id) });
});

/** DELETE /api/lists/:id/share/:userId - stop sharing with a user. */
router.delete('/:id/share/:userId', (req, res) => {
  const ctx = loadAccessibleList(req, res);
  if (!ctx) return;

  const targetId = Number.parseInt(req.params.userId, 10);
  // Owners may remove anyone; collaborators may remove themselves.
  if (ctx.level !== 'owner' && targetId !== req.user.id) {
    return res
      .status(403)
      .json({ error: 'Only the list owner can remove collaborators.' });
  }
  deleteShare.run(ctx.list.id, targetId);
  res.json({ ok: true });
});

module.exports = router;
