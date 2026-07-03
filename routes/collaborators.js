const express = require('express');
const bcrypt = require('bcrypt');
const { getDb } = require('../db/sqlite');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../middleware/audit');
const router = express.Router();

// GET /api/v1/collaborators (already in server.js, but we add the detail + permissions routes here)
// This is the detail endpoint
router.get('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const user = db.prepare(`
    SELECT c.*, r.name as role_name, r.description as role_description
    FROM collaborators c
    LEFT JOIN roles r ON c.role_id = r.id
    WHERE c.id = ?
  `).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Colaborador no encontrado' });
  delete user.password_hash;
  res.json({ collaborator: user });
});

// POST /api/v1/collaborators
router.post('/', requireAuth, requirePermission('collaborators', 'create'), (req, res) => {
  const db = getDb();
  const { name, email, role_id, password } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Nombre y email requeridos' });

  const existing = db.prepare('SELECT id FROM collaborators WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Ya existe un colaborador con ese email' });

  const id = 'col-' + Date.now();
  const passwordHash = password ? bcrypt.hashSync(password, 12) : null;
  const defaultRole = role_id || db.prepare("SELECT id FROM roles WHERE name = 'Colaborador'").get()?.id;

  db.prepare(`
    INSERT INTO collaborators (id, name, email, password_hash, role_id, status)
    VALUES (?, ?, ?, ?, ?, 'Activo')
  `).run(id, name, email, passwordHash, defaultRole);

  const created = db.prepare('SELECT id, name, email, role_id, status, created_at FROM collaborators WHERE id = ?').get(id);
  logAudit(req, 'collaborator_created', 'collaborator', id, null, created);
  res.status(201).json({ success: true, collaborator: created });
});

// PUT /api/v1/collaborators/:id
router.put('/:id', requireAuth, requirePermission('collaborators', 'edit'), (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM collaborators WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Colaborador no encontrado' });

  const { name, email, role_id, status, password } = req.body;
  const updates = [];
  const params = [];

  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (email !== undefined) { updates.push('email = ?'); params.push(email); }
  if (role_id !== undefined) { updates.push('role_id = ?'); params.push(role_id); }
  if (status !== undefined) { updates.push('status = ?'); params.push(status); }
  if (password) { updates.push('password_hash = ?'); params.push(bcrypt.hashSync(password, 12)); }

  if (updates.length > 0) {
    updates.push("updated_at = CURRENT_TIMESTAMP");
    params.push(req.params.id);
    db.prepare(`UPDATE collaborators SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  const updated = db.prepare(`
    SELECT c.id, c.name, c.email, c.role_id, c.status, c.google_calendar_status,
           c.last_login_at, c.created_at, r.name as role_name
    FROM collaborators c
    LEFT JOIN roles r ON c.role_id = r.id
    WHERE c.id = ?
  `).get(req.params.id);

  logAudit(req, 'collaborator_updated', 'collaborator', req.params.id, user, updated);
  res.json({ success: true, collaborator: updated });
});

// DELETE /api/v1/collaborators/:id
router.delete('/:id', requireAuth, requirePermission('collaborators', 'delete'), (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM collaborators WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Colaborador no encontrado' });

  // Don't allow deleting self
  if (req.params.id === req.session.userId) {
    return res.status(403).json({ error: 'No puedes eliminarte a ti mismo' });
  }

  db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM google_tokens WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM collaborators WHERE id = ?').run(req.params.id);
  logAudit(req, 'collaborator_deleted', 'collaborator', req.params.id, user, null);
  res.json({ success: true });
});

// GET /api/v1/collaborators/:id/permissions — user-specific overrides
router.get('/:id/permissions', requireAuth, requirePermission('collaborators', 'manage_permissions'), (req, res) => {
  const db = getDb();
  const perms = db.prepare('SELECT module_id, actions FROM user_permissions WHERE user_id = ?').all(req.params.id);
  const result = {};
  perms.forEach(p => { result[p.module_id] = JSON.parse(p.actions); });
  res.json({ permissions: result });
});

// PUT /api/v1/collaborators/:id/permissions — update user-specific overrides
router.put('/:id/permissions', requireAuth, requirePermission('collaborators', 'manage_permissions'), (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id FROM collaborators WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Colaborador no encontrado' });

  const { permissions } = req.body;
  const upsert = db.prepare(
    'INSERT OR REPLACE INTO user_permissions (user_id, module_id, actions) VALUES (?, ?, ?)'
  );
  const del = db.prepare('DELETE FROM user_permissions WHERE user_id = ? AND module_id = ?');

  const tx = db.transaction(() => {
    for (const [moduleId, actions] of Object.entries(permissions || {})) {
      if (Array.isArray(actions) && actions.length > 0) {
        upsert.run(req.params.id, moduleId, JSON.stringify(actions));
      } else {
        del.run(req.params.id, moduleId);
      }
    }
  });
  tx();

  logAudit(req, 'user_permissions_updated', 'collaborator', req.params.id, null, { permissions });
  res.json({ success: true });
});

module.exports = router;
