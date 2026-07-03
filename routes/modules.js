const express = require('express');
const { getDb } = require('../db/sqlite');
const { requireAuth, requirePermission } = require('../middleware/auth');
const router = express.Router();

// GET /api/v1/modules — lista completa de módulos con sus acciones
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const modules = db.prepare('SELECT * FROM modules ORDER BY sort_order').all();
  const actions = db.prepare('SELECT * FROM module_actions ORDER BY module_id, action').all();

  const result = modules.map(m => ({
    ...m,
    actions: actions.filter(a => a.module_id === m.id).map(a => ({ action: a.action, label: a.label }))
  }));

  res.json({ modules: result });
});

module.exports = router;
