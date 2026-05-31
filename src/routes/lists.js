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

// ---- Access helpers ------------------------------------------------------

/**
 * Returns 'owner', 'collaborator' or null describing how `userId` may access
 * the given list.
 */
async function accessLevel(list, userId) {
  if (!list) return null;
  if (list.owner_id === userId) return 'owner';
  const share = await db.get(
    'SELECT 1 FROM list_shares WHERE list_id = $1 AND user_id = $2',
    [list.id, userId]
  );
  if (share) return 'collaborator';
  return null;
}

async function serializeList(list, currentUserId) {
  const owner = await db.get(
    'SELECT id, phone, display_name FROM users WHERE id = $1',
    [list.owner_id]
  );
  const items = await db.all(
    'SELECT * FROM list_items WHERE list_id = $1 ORDER BY checked ASC, position ASC, id ASC',
    [list.id]
  );
  const collaborators = await db.all(
    `SELECT u.id, u.phone, u.display_name
     FROM list_shares s JOIN users u ON u.id = s.user_id
     WHERE s.list_id = $1 ORDER BY u.display_name, u.phone`,
    [list.id]
  );
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
    items: items.map((it) => ({
      id: it.id,
      text: it.text,
      checked: !!it.checked,
      position: it.position,
    })),
    collaborators: collaborators.map((u) => ({
      id: u.id,
      phone: u.phone,
      displayName: u.display_name,
    })),
  };
}

/** Loads a list and verifies the current user may access it. */
async function loadAccessibleList(req, res) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'Invalid list id.' });
    return null;
  }
  const list = await db.get('SELECT * FROM lists WHERE id = $1', [id]);
  const level = await accessLevel(list, req.user.id);
  if (!level) {
    res.status(404).json({ error: 'List not found.' });
    return null;
  }
  return { list, level };
}

// ---- List endpoints ------------------------------------------------------

/** GET /api/lists - all lists owned by or shared with the current user. */
router.get('/', async (req, res, next) => {
  try {
    const rows = await db.all(
      `SELECT DISTINCT l.* FROM lists l
       LEFT JOIN list_shares s ON s.list_id = l.id
       WHERE l.owner_id = $1 OR s.user_id = $1
       ORDER BY l.archived ASC, l.position DESC, l.updated_at DESC`,
      [req.user.id]
    );
    const lists = await Promise.all(
      rows.map((l) => serializeList(l, req.user.id))
    );
    res.json({ lists });
  } catch (err) {
    next(err);
  }
});

/** POST /api/lists - create a new list. */
router.post('/', async (req, res, next) => {
  try {
    const title = cleanText(req.body.title, 120);
    let color = cleanText(req.body.color, 20) || 'default';
    if (!ALLOWED_COLORS.has(color)) color = 'default';

    const { p } = await db.get(
      'SELECT COALESCE(MAX(position), 0) AS p FROM lists WHERE owner_id = $1',
      [req.user.id]
    );
    const created = await db.get(
      `INSERT INTO lists (owner_id, title, color, position)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.user.id, title, color, p + 1]
    );

    // Optionally accept an initial set of items.
    if (Array.isArray(req.body.items)) {
      let pos = 0;
      for (const raw of req.body.items.slice(0, 200)) {
        const text = cleanText(raw && raw.text, 300);
        if (text) {
          // eslint-disable-next-line no-await-in-loop
          await db.query(
            'INSERT INTO list_items (list_id, text, position) VALUES ($1, $2, $3)',
            [created.id, text, ++pos]
          );
        }
      }
    }

    res.status(201).json({ list: await serializeList(created, req.user.id) });
  } catch (err) {
    next(err);
  }
});

/** GET /api/lists/:id */
router.get('/:id', async (req, res, next) => {
  try {
    const ctx = await loadAccessibleList(req, res);
    if (!ctx) return;
    res.json({ list: await serializeList(ctx.list, req.user.id) });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/lists/:id - update title/color/archived (owner or collaborator). */
router.patch('/:id', async (req, res, next) => {
  try {
    const ctx = await loadAccessibleList(req, res);
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

    await db.query(
      `UPDATE lists
       SET title = $1, color = $2, archived = $3, updated_at = now()
       WHERE id = $4`,
      [title, color, archived, list.id]
    );
    const updated = await db.get('SELECT * FROM lists WHERE id = $1', [list.id]);
    res.json({ list: await serializeList(updated, req.user.id) });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/lists/:id - owner only. */
router.delete('/:id', async (req, res, next) => {
  try {
    const ctx = await loadAccessibleList(req, res);
    if (!ctx) return;
    if (ctx.level !== 'owner') {
      return res
        .status(403)
        .json({ error: 'Only the list owner can delete it.' });
    }
    await db.query('DELETE FROM lists WHERE id = $1', [ctx.list.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- Item endpoints ------------------------------------------------------

/** POST /api/lists/:id/items - add an item. */
router.post('/:id/items', async (req, res, next) => {
  try {
    const ctx = await loadAccessibleList(req, res);
    if (!ctx) return;

    const text = cleanText(req.body.text, 300);
    if (!text) {
      return res.status(400).json({ error: 'Item text is required.' });
    }
    const { p } = await db.get(
      'SELECT COALESCE(MAX(position), 0) AS p FROM list_items WHERE list_id = $1',
      [ctx.list.id]
    );
    await db.query(
      'INSERT INTO list_items (list_id, text, position) VALUES ($1, $2, $3)',
      [ctx.list.id, text, p + 1]
    );
    await db.query('UPDATE lists SET updated_at = now() WHERE id = $1', [
      ctx.list.id,
    ]);
    const updated = await db.get('SELECT * FROM lists WHERE id = $1', [
      ctx.list.id,
    ]);
    res
      .status(201)
      .json({ list: await serializeList(updated, req.user.id) });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/lists/:id/items/:itemId - toggle/edit an item. */
router.patch('/:id/items/:itemId', async (req, res, next) => {
  try {
    const ctx = await loadAccessibleList(req, res);
    if (!ctx) return;

    const itemId = Number.parseInt(req.params.itemId, 10);
    const item = await db.get(
      'SELECT * FROM list_items WHERE id = $1 AND list_id = $2',
      [itemId, ctx.list.id]
    );
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

    await db.query(
      'UPDATE list_items SET text = $1, checked = $2 WHERE id = $3',
      [text, checked, itemId]
    );
    res.json({ list: await serializeList(ctx.list, req.user.id) });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/lists/:id/items/:itemId */
router.delete('/:id/items/:itemId', async (req, res, next) => {
  try {
    const ctx = await loadAccessibleList(req, res);
    if (!ctx) return;

    const itemId = Number.parseInt(req.params.itemId, 10);
    const item = await db.get(
      'SELECT * FROM list_items WHERE id = $1 AND list_id = $2',
      [itemId, ctx.list.id]
    );
    if (!item) {
      return res.status(404).json({ error: 'Item not found.' });
    }
    await db.query('DELETE FROM list_items WHERE id = $1', [itemId]);
    res.json({ list: await serializeList(ctx.list, req.user.id) });
  } catch (err) {
    next(err);
  }
});

// ---- Collaboration endpoints --------------------------------------------

/** POST /api/lists/:id/share - share with another user by phone number. */
router.post('/:id/share', async (req, res, next) => {
  try {
    const ctx = await loadAccessibleList(req, res);
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

    const target = await db.get(
      'SELECT id, phone, display_name, status FROM users WHERE phone = $1',
      [phone]
    );
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

    await db.query(
      `INSERT INTO list_shares (list_id, user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [ctx.list.id, target.id]
    );
    res.json({ list: await serializeList(ctx.list, req.user.id) });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/lists/:id/share/:userId - stop sharing with a user. */
router.delete('/:id/share/:userId', async (req, res, next) => {
  try {
    const ctx = await loadAccessibleList(req, res);
    if (!ctx) return;

    const targetId = Number.parseInt(req.params.userId, 10);
    // Owners may remove anyone; collaborators may remove themselves.
    if (ctx.level !== 'owner' && targetId !== req.user.id) {
      return res
        .status(403)
        .json({ error: 'Only the list owner can remove collaborators.' });
    }
    await db.query(
      'DELETE FROM list_shares WHERE list_id = $1 AND user_id = $2',
      [ctx.list.id, targetId]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
