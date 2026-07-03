const express = require('express');
const bcrypt = require('bcrypt');
const { getDb } = require('../db/sqlite');
const { requireAuth, getUserPermissions } = require('../middleware/auth');
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

// GET /api/v1/auth/me
router.get('/me', requireAuth, (req, res) => {
  const db = getDb();
  const user = db.prepare(`
    SELECT c.id, c.name, c.last_name, c.email, c.role_id, c.status,
           c.google_calendar_status, c.google_account_email, c.last_sync_at, c.last_login_at,
           r.name as role_name, r.description as role_description
    FROM collaborators c
    LEFT JOIN roles r ON c.role_id = r.id
    WHERE c.id = ?
  `).get(req.session.userId);

  if (!user) {
    req.session.destroy();
    return res.status(401).json({ error: 'User not found' });
  }

  const permissions = getUserPermissions(user.id);

  res.json({
    success: true,
    user,
    permissions
  });
});

module.exports = router;
