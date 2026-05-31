'use strict';

const express = require('express');

const db = require('../db');
const { requireAdmin } = require('../auth');

const router = express.Router();

// All admin endpoints require the admin role.
router.use(requireAdmin);

function publicUser(user) {
  return {
    id: user.id,
    phone: user.phone,
    displayName: user.display_name,
    role: user.role,
    status: user.status,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  };
}

/** GET /api/admin/users - list every account, pending first. */
router.get('/users', async (req, res, next) => {
  try {
    const users = await db.all(
      `SELECT id, phone, display_name, role, status, created_at, updated_at
       FROM users ORDER BY
         CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
         created_at DESC`
    );
    res.json({ users: users.map(publicUser) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/users/:id/decision
 * body: { decision: 'approve' | 'decline' }
 * Approves or declines a user's access request.
 */
router.post('/users/:id/decision', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const user = await db.get('SELECT * FROM users WHERE id = $1', [id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const decision = req.body.decision;
    const statusMap = { approve: 'approved', decline: 'declined' };
    const newStatus = statusMap[decision];
    if (!newStatus) {
      return res
        .status(400)
        .json({ error: "decision must be 'approve' or 'decline'." });
    }

    // Guard: never lock the platform out of all administrators.
    if (
      user.role === 'admin' &&
      user.status === 'approved' &&
      newStatus !== 'approved'
    ) {
      const { n } = await db.get(
        "SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND status = 'approved'"
      );
      if (n <= 1) {
        return res
          .status(400)
          .json({ error: 'Cannot decline the last remaining administrator.' });
      }
    }

    await db.query(
      'UPDATE users SET status = $1, updated_at = now() WHERE id = $2',
      [newStatus, id]
    );
    const updated = await db.get('SELECT * FROM users WHERE id = $1', [id]);
    res.json({ user: publicUser(updated) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
