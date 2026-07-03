const express = require('express');
const { getDb } = require('../db/sqlite');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../middleware/audit');
const router = express.Router();

// GET /api/v1/roles
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const roles = db.prepare('SELECT * FROM roles ORDER BY is_system DESC, name').all();
  // Count users per role
  const counts = db.prepare('SELECT role_id, COUNT(*) as cnt FROM collaborators GROUP BY role_id').all();
  const countMap = {};
  counts.forEach(c => { countMap[c.role_id] = c.cnt; });
  res.json({ roles: roles.map(r => ({ ...r, user_count: countMap[r.id] || 0 })) });
});

// POST /api/v1/roles
router.post('/', requireAuth, requirePermission('roles', 'create'), (req, res) => {
  const db = getDb();
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const existing = db.prepare('SELECT id FROM roles WHERE name = ?').get(name);
  if (existing) return res.status(409).json({ error: 'Ya existe un rol con ese nombre' });

  const id = 'role-' + Date.now();
  db.prepare('INSERT INTO roles (id, name, description) VALUES (?, ?, ?)').run(id, name, description || '');

  // Inherit read-only permissions from the 'Colaborador' role
  const readonlyRole = db.prepare("SELECT id FROM roles WHERE name = 'Solo lectura'").get();
  if (readonlyRole) {
    const perms = db.prepare('SELECT module_id, actions FROM role_permissions WHERE role_id = ?').all(readonlyRole.id);
    const ins = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, module_id, actions) VALUES (?, ?, ?)');
    for (const p of perms) ins.run(id, p.module_id, p.actions);
  }

  logAudit(req, 'role_created', 'role', id, null, { name, description });
  res.status(201).json({ success: true, role: { id, name, description, is_system: 0, user_count: 0 } });
});

// PUT /api/v1/roles/:id
router.put('/:id', requireAuth, requirePermission('roles', 'edit'), (req, res) => {
  const db = getDb();
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Rol no encontrado' });

  const { name, description } = req.body;
  if (name && name !== role.name) {
    const dup = db.prepare('SELECT id FROM roles WHERE name = ? AND id != ?').get(name, req.params.id);
    if (dup) return res.status(409).json({ error: 'Ya existe un rol con ese nombre' });
  }

  db.prepare('UPDATE roles SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?')
    .run(name || null, description !== undefined ? description : null, req.params.id);

  const updated = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  logAudit(req, 'role_updated', 'role', req.params.id, role, updated);
  res.json({ success: true, role: updated });
});

// DELETE /api/v1/roles/:id
router.delete('/:id', requireAuth, requirePermission('roles', 'delete'), (req, res) => {
  const db = getDb();
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Rol no encontrado' });
  if (role.is_system) return res.status(403).json({ error: 'No se puede eliminar un rol del sistema' });

  // Reassign users to 'Colaborador' role
  const defaultRole = db.prepare("SELECT id FROM roles WHERE name = 'Colaborador'").get();
  if (defaultRole) {
    db.prepare('UPDATE collaborators SET role_id = ? WHERE role_id = ?').run(defaultRole.id, req.params.id);
  }

  db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(req.params.id);
  db.prepare('DELETE FROM roles WHERE id = ?').run(req.params.id);
  logAudit(req, 'role_deleted', 'role', req.params.id, role, null);
  res.json({ success: true });
});

// GET /api/v1/roles/:id/permissions
router.get('/:id/permissions', requireAuth, (req, res) => {
  const db = getDb();
  const perms = db.prepare('SELECT module_id, actions FROM role_permissions WHERE role_id = ?').all(req.params.id);
  const result = {};
  perms.forEach(p => { result[p.module_id] = JSON.parse(p.actions); });
  res.json({ permissions: result });
});

// PUT /api/v1/roles/:id/permissions — actualiza la matriz completa
router.put('/:id/permissions', requireAuth, requirePermission('roles', 'edit'), (req, res) => {
  const db = getDb();
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Rol no encontrado' });

  const { permissions } = req.body; // { module_id: [action1, action2, ...] }
  if (!permissions) return res.status(400).json({ error: 'Se requiere mapa de permisos' });

  const upsert = db.prepare(
    'INSERT OR REPLACE INTO role_permissions (role_id, module_id, actions) VALUES (?, ?, ?)'
  );
  const del = db.prepare('DELETE FROM role_permissions WHERE role_id = ? AND module_id = ?');

  const tx = db.transaction(() => {
    for (const [moduleId, actions] of Object.entries(permissions)) {
      if (Array.isArray(actions) && actions.length > 0) {
        upsert.run(req.params.id, moduleId, JSON.stringify(actions));
      } else {
        del.run(req.params.id, moduleId);
      }
    }
  });
  tx();

  logAudit(req, 'role_permissions_updated', 'role', req.params.id, null, { permissions });
  res.json({ success: true });
});

module.exports = router;
