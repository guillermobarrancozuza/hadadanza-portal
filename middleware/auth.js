const { getDb } = require('../db/sqlite');

/**
 * Middleware: Requiere que el usuario esté autenticado.
 * Si no hay sesión, responde 401.
 */
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

/**
 * Middleware: Verifica que el usuario tenga un permiso específico.
 * @param {string} moduleId - ID del módulo (ej: 'calendar', 'events_edit')
 * @param {string} action - Acción (ej: 'view', 'create', 'edit', 'delete')
 * @param {object} options
 * @param {boolean} options.allowAdmin - Si true, admin pasa siempre (default: true)
 */
function requirePermission(moduleId, action, options = {}) {
  const { allowAdmin = true } = options;
  return (req, res, next) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = req.session.userId;
    const db = getDb();

    // Get user's role
    const user = db.prepare('SELECT role_id FROM collaborators WHERE id = ?').get(userId);
    if (!user) return res.status(401).json({ error: 'User not found' });

    // Admin always passes if allowAdmin
    if (allowAdmin) {
      const adminRole = db.prepare("SELECT id FROM roles WHERE name = 'Administrador'").get();
      if (adminRole && user.role_id === adminRole.id) return next();
    }

    // Check user-specific permission override
    const userPerm = db.prepare(
      'SELECT actions FROM user_permissions WHERE user_id = ? AND module_id = ?'
    ).get(userId, moduleId);

    if (userPerm) {
      const actions = JSON.parse(userPerm.actions);
      if (actions.includes(action) || actions.includes('*')) return next();
      return res.status(403).json({ error: 'Forbidden', detail: `Missing ${action} on ${moduleId}` });
    }

    // Check role-based permission
    const rolePerm = db.prepare(
      'SELECT actions FROM role_permissions WHERE role_id = ? AND module_id = ?'
    ).get(user.role_id, moduleId);

    if (rolePerm) {
      const actions = JSON.parse(rolePerm.actions);
      if (actions.includes(action) || actions.includes('*')) return next();
    }

    return res.status(403).json({ error: 'Forbidden', detail: `Missing ${action} on ${moduleId}` });
  };
}

/**
 * Helper: Obtiene la lista completa de permisos de un usuario.
 * Combina role_permissions + user_permissions con override.
 */
function getUserPermissions(userId) {
  const db = getDb();
  const user = db.prepare('SELECT role_id FROM collaborators WHERE id = ?').get(userId);
  if (!user) return {};

  // Get all modules
  const modules = db.prepare('SELECT id FROM modules').all();
  const permissions = {};

  for (const mod of modules) {
    // Check user-specific override first
    const userPerm = db.prepare(
      'SELECT actions FROM user_permissions WHERE user_id = ? AND module_id = ?'
    ).get(userId, mod.id);

    if (userPerm && JSON.parse(userPerm.actions).length > 0) {
      permissions[mod.id] = JSON.parse(userPerm.actions);
      continue;
    }

    // Fall back to role permission
    const rolePerm = db.prepare(
      'SELECT actions FROM role_permissions WHERE role_id = ? AND module_id = ?'
    ).get(user.role_id, mod.id);

    permissions[mod.id] = rolePerm ? JSON.parse(rolePerm.actions) : [];
  }

  return permissions;
}

module.exports = { requireAuth, requirePermission, getUserPermissions };
