const { getDb } = require('../db/sqlite');

/**
 * Registra una acción en el log de auditoría.
 */
function logAudit(req, action, targetType, targetId, oldValue = null, newValue = null) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO audit_log (user_id, action, target_type, target_id, old_value, new_value, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.session?.userId || 'system',
      action,
      targetType,
      targetId,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null,
      req.ip || req.connection?.remoteAddress || null,
      req.headers['user-agent'] || null
    );
  } catch (err) {
    console.error('Audit log error:', err.message);
  }
}

/**
 * Middleware wrapper para auditoría automática en rutas.
 */
function audit(action, targetType, targetIdFn) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      if (res.statusCode < 400 && body?.success) {
        const targetId = typeof targetIdFn === 'function' ? targetIdFn(req, body) : targetIdFn;
        logAudit(req, action, targetType, targetId);
      }
      return originalJson(body);
    };
    next();
  };
}

module.exports = { logAudit, audit };
