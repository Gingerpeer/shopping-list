'use strict';

const express = require('express');

const db = require('../db');
const { requireAdmin } = require('../auth');

const router = express.Router();

// All admin endpoints require the admin role.
router.use(requireAdmin);

const listUsers = db.prepare(
  `SELECT id, phone, display_name, role, status, created_at, updated_at
   FROM users ORDER BY
     CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
     created_at DESC`
);
const getUser = db.prepare('SELECT * FROM users WHERE id = ?');
const setStatus = db.prepare(
  "UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?"
);
const countAdmins = db.prepare(
  "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'approved'"
);

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
router.get('/users', (req, res) => {
  res.json({ users: listUsers.all().map(publicUser) });
});

/**
 * POST /api/admin/users/:id/decision
 * body: { decision: 'approve' | 'decline' }
 * Approves or declines a user's access request.
 */
router.post('/users/:id/decision', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const user = getUser.get(id);
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
    newStatus !== 'approved' &&
    countAdmins.get().n <= 1
  ) {
    return res
      .status(400)
      .json({ error: 'Cannot decline the last remaining administrator.' });
  }

  setStatus.run(newStatus, id);
  res.json({ user: publicUser(getUser.get(id)) });
});

module.exports = router;
