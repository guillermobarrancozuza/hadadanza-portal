const express = require('express');
const bcrypt = require('bcrypt');
const { getDb } = require('../db/sqlite');
const { requireAuth, getUserPermissions } = require('../middleware/auth');
const { logAudit } = require('../middleware/audit');
const router = express.Router();

// POST /api/v1/auth/login
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña requeridos' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM collaborators WHERE email = ?').get(email);
  if (!user) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }

  if (!user.password_hash) {
    return res.status(401).json({ error: 'Esta cuenta no tiene contraseña configurada' });
  }

  if (user.status !== 'Activo') {
    return res.status(403).json({ error: 'Cuenta desactivada' });
  }

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }

  // Update last login
  db.prepare('UPDATE collaborators SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

  // Create session
  req.session.userId = user.id;
  req.session.userName = user.name;
  req.session.userRole = user.role_id;

  // Get full permissions
  const permissions = getUserPermissions(user.id);

  res.json({
    success: true,
    user: {
      id: user.id,
      name: user.name,
      last_name: user.last_name,
      email: user.email,
      role_id: user.role_id,
      status: user.status,
      google_calendar_status: user.google_calendar_status,
      google_account_email: user.google_account_email,
      last_sync_at: user.last_sync_at,
    },
    permissions
  });
});

// POST /api/v1/auth/login-pin
router.post('/login-pin', (req, res) => {
  const { email, pin } = req.body;
  if (!email || !pin) {
    return res.status(400).json({ error: 'Email y PIN requeridos' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM collaborators WHERE email = ?').get(email);
  if (!user || user.pin !== pin) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }

  if (user.status !== 'Activo') {
    return res.status(403).json({ error: 'Cuenta desactivada' });
  }

  db.prepare('UPDATE collaborators SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  req.session.userId = user.id;
  req.session.userName = user.name;
  req.session.userRole = user.role_id;

  const permissions = getUserPermissions(user.id);

  res.json({
    success: true,
    user: {
      id: user.id, name: user.name, last_name: user.last_name,
      email: user.email, role_id: user.role_id, status: user.status,
      google_calendar_status: user.google_calendar_status, google_account_email: user.google_account_email,
    },
    permissions
  });
});

// POST /api/v1/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// GET /api/v1/auth/me (soporta impersonación)
router.get('/me', requireAuth, (req, res) => {
  const db = getDb();
  const targetId = req.session.impersonating || req.session.userId;
  const user = db.prepare(`
    SELECT c.id, c.name, c.last_name, c.email, c.role_id, c.status,
           c.google_calendar_status, c.google_account_email, c.last_sync_at, c.last_login_at,
           r.name as role_name, r.description as role_description
    FROM collaborators c
    LEFT JOIN roles r ON c.role_id = r.id
    WHERE c.id = ?
  `).get(targetId);

  if (!user) {
    req.session.destroy();
    return res.status(401).json({ error: 'User not found' });
  }

  const permissions = getUserPermissions(user.id);

  const response = {
    success: true,
    user,
    permissions
  };

  // Si está impersonando, incluir info del admin original
  if (req.session.impersonating) {
    const admin = db.prepare('SELECT id, name, email FROM collaborators WHERE id = ?').get(req.session.userId);
    response.impersonating = true;
    response.impersonated_by = admin ? { id: admin.id, name: admin.name, email: admin.email } : null;
  }

  res.json(response);
});

// POST /api/v1/auth/impersonate/:userId — Admin suplanta a otro usuario
router.post('/impersonate/:userId', requireAuth, (req, res) => {
  const db = getDb();
  const adminUser = db.prepare('SELECT role_id FROM collaborators WHERE id = ?').get(req.session.userId);
  const adminRole = db.prepare("SELECT id FROM roles WHERE name = 'Administrador'").get();
  const isAdmin = adminRole && adminUser && adminUser.role_id === adminRole.id;

  if (!isAdmin) {
    return res.status(403).json({ error: 'Solo el administrador puede suplantar usuarios' });
  }

  const target = db.prepare('SELECT id, name, email, role_id, status FROM collaborators WHERE id = ?').get(req.params.userId);
  if (!target) {
    return res.status(404).json({ error: 'Usuario no encontrado' });
  }
  if (target.status !== 'Activo') {
    return res.status(400).json({ error: 'No se puede suplantar un usuario inactivo' });
  }

  req.session.impersonating = target.id;
  logAudit(req, 'impersonate_start', 'collaborator', target.id, null, { adminId: req.session.userId });

  const permissions = getUserPermissions(target.id);
  res.json({
    success: true,
    impersonating: true,
    user: target,
    permissions
  });
});

// POST /api/v1/auth/unimpersonate — Admin vuelve a su cuenta
router.post('/unimpersonate', requireAuth, (req, res) => {
  if (!req.session.impersonating) {
    return res.status(400).json({ error: 'No estás suplantando a ningún usuario' });
  }

  const targetId = req.session.impersonating;
  delete req.session.impersonating;

  const db = getDb();
  const admin = db.prepare(`
    SELECT c.id, c.name, c.last_name, c.email, c.role_id, c.status,
           c.google_calendar_status, c.google_account_email, c.last_sync_at, c.last_login_at,
           r.name as role_name, r.description as role_description
    FROM collaborators c
    LEFT JOIN roles r ON c.role_id = r.id
    WHERE c.id = ?
  `).get(req.session.userId);

  const permissions = getUserPermissions(req.session.userId);
  logAudit(req, 'impersonate_end', 'collaborator', targetId, null, { adminId: req.session.userId });

  res.json({
    success: true,
    user: admin,
    permissions
  });
});

module.exports = router;
