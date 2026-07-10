const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcrypt');

const DB_PATH = path.join(__dirname, '..', 'storage', 'hadadanza.db');
let db;

function initDatabase() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // ── TABLAS ──────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY DEFAULT ('role-' || lower(hex(randomblob(16)))),
      name TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      is_system BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS collaborators (
      id TEXT PRIMARY KEY DEFAULT ('col-' || lower(hex(randomblob(16)))),
      name TEXT NOT NULL DEFAULT 'Nuevo Colaborador',
      last_name TEXT DEFAULT '',
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      pin TEXT,
      role_id TEXT REFERENCES roles(id),
      status TEXT DEFAULT 'Activo' CHECK(status IN ('Activo','Inactivo','Pendiente')),
      google_account_email TEXT,
      google_calendar_status TEXT DEFAULT 'disconnected' CHECK(google_calendar_status IN ('disconnected','syncing','synced','error')),
      last_sync_at DATETIME,
      last_login_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS modules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      label TEXT NOT NULL,
      icon TEXT DEFAULT 'fa-cube',
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS module_actions (
      id TEXT PRIMARY KEY,
      module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      label TEXT NOT NULL,
      UNIQUE(module_id, action)
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      actions TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (role_id, module_id)
    );

    CREATE TABLE IF NOT EXISTS user_permissions (
      user_id TEXT NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
      module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      actions TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (user_id, module_id)
    );

    CREATE TABLE IF NOT EXISTS google_tokens (
      user_id TEXT PRIMARY KEY REFERENCES collaborators(id) ON DELETE CASCADE,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expiry_date DATETIME,
      scope TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS event_mapping (
      event_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      google_event_id TEXT NOT NULL,
      google_calendar_id TEXT DEFAULT 'primary',
      last_sync_at DATETIME,
      last_sync_direction TEXT,
      PRIMARY KEY (event_id, user_id, google_calendar_id)
    );
    CREATE INDEX IF NOT EXISTS idx_google_event ON event_mapping(google_event_id);

    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT REFERENCES collaborators(id),
      event_id TEXT,
      action TEXT NOT NULL CHECK(action IN ('create','update','delete')),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','done','failed')),
      retry_count INTEGER DEFAULT 0,
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT REFERENCES collaborators(id),
      direction TEXT,
      status TEXT,
      events_synced INTEGER DEFAULT 0,
      events_created INTEGER DEFAULT 0,
      events_updated INTEGER DEFAULT 0,
      events_deleted INTEGER DEFAULT 0,
      error_message TEXT,
      details TEXT,
      started_at DATETIME,
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT REFERENCES collaborators(id),
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      old_value TEXT,
      new_value TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY DEFAULT ('tmpl-' || lower(hex(randomblob(16)))),
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      type TEXT NOT NULL CHECK(type IN ('contract','technical')),
      category TEXT DEFAULT 'General',
      content TEXT NOT NULL DEFAULT '',
      file_name TEXT DEFAULT '',
      file_type TEXT DEFAULT '',
      file_data BLOB,
      is_active BOOLEAN DEFAULT 1,
      created_by TEXT REFERENCES collaborators(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS template_event_assignments (
      event_id TEXT NOT NULL,
      template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('contract','technical')),
      PRIMARY KEY (event_id, type)
    );

    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── MIGRATION: add file columns to templates if missing ──
  try {
    const cols = db.prepare("PRAGMA table_info('templates')").all().map(c => c.name);
    if (!cols.includes('file_name')) {
      db.exec("ALTER TABLE templates ADD COLUMN file_name TEXT DEFAULT ''");
    }
    if (!cols.includes('file_type')) {
      db.exec("ALTER TABLE templates ADD COLUMN file_type TEXT DEFAULT ''");
    }
    if (!cols.includes('file_data')) {
      db.exec("ALTER TABLE templates ADD COLUMN file_data BLOB");
    }
  } catch(e) {
    console.warn('Migration note: file columns may already exist:', e.message);
  }

  // ── SEED ROLES ──────────────────────────────────────
  const roleCount = db.prepare('SELECT COUNT(*) as cnt FROM roles').get().cnt;
  if (roleCount === 0) {
    const insertRole = db.prepare('INSERT INTO roles (id, name, description, is_system) VALUES (?, ?, ?, ?)');
    insertRole.run('role-admin', 'Administrador', 'Acceso total al sistema', 1);
    insertRole.run('role-supervisor', 'Supervisor', 'Puede ver y editar casi todo, sin gestionar permisos', 1);
    insertRole.run('role-coordinator', 'Coordinador', 'Gestión operativa del calendario y eventos', 0);
    insertRole.run('role-commercial', 'Comercial', 'Enfoque en ventas y presupuestos', 0);
    insertRole.run('role-collaborator', 'Colaborador', 'Acceso a lo asignado, por defecto solo lectura', 0);
    insertRole.run('role-readonly', 'Solo lectura', 'Solo puede visualizar, sin modificaciones', 1);
  }

  // ── SEED MODULES ────────────────────────────────────
  const moduleCount = db.prepare('SELECT COUNT(*) as cnt FROM modules').get().cnt;
  if (moduleCount === 0) {
    const modules = [
      { id: 'calendar', name: 'calendar', label: 'Calendario', icon: 'fa-calendar', sort: 1 },
      { id: 'events_info', name: 'events_info', label: 'Info. Básica', icon: 'fa-sitemap', sort: 2 },
      { id: 'events_contacts', name: 'events_contacts', label: 'Contactos', icon: 'fa-address-book', sort: 3 },
      { id: 'events_tasks', name: 'events_tasks', label: 'Tareas', icon: 'fa-check-square', sort: 4 },
      { id: 'events_files', name: 'events_files', label: 'Archivos', icon: 'fa-paperclip', sort: 5 },
      { id: 'events_contract', name: 'events_contract', label: 'Contrato', icon: 'fa-file-signature', sort: 6 },
      { id: 'events_ticketing', name: 'events_ticketing', label: 'Entradas', icon: 'fa-ticket', sort: 7 },
      { id: 'events_guests', name: 'events_guests', label: 'Invitados', icon: 'fa-clipboard-list', sort: 8 },
      { id: 'events_accommodation', name: 'events_accommodation', label: 'Alojamiento', icon: 'fa-bed', sort: 9 },
      { id: 'events_hospitality', name: 'events_hospitality', label: 'Hospitalidad', icon: 'fa-mug-hot', sort: 10 },
      { id: 'events_travel', name: 'events_travel', label: 'Viaje', icon: 'fa-plane', sort: 11 },
      { id: 'events_technical', name: 'events_technical', label: 'Técnico', icon: 'fa-sliders', sort: 12 },
      { id: 'events_schedule', name: 'events_schedule', label: 'Horarios', icon: 'fa-clock', sort: 13 },
      { id: 'events_accounting', name: 'events_accounting', label: 'Contabilidad', icon: 'fa-dollar-sign', sort: 14 },
      { id: 'events_promotion', name: 'events_promotion', label: 'Promoción', icon: 'fa-bullhorn', sort: 15 },
      { id: 'crew', name: 'crew', label: 'Crew', icon: 'fa-users', sort: 16 },
      { id: 'collaborators', name: 'collaborators', label: 'Colaboradores', icon: 'fa-address-card', sort: 17 },
      { id: 'economy', name: 'economy', label: 'Resumen económico', icon: 'fa-dollar-sign', sort: 18 },
      { id: 'roles', name: 'roles', label: 'Roles', icon: 'fa-lock', sort: 19 },
      { id: 'settings', name: 'settings', label: 'Configuración', icon: 'fa-gear', sort: 20 },
    ];
    const insMod = db.prepare('INSERT INTO modules (id, name, label, icon, sort_order) VALUES (?, ?, ?, ?, ?)');
    for (const m of modules) insMod.run(m.id, m.name, m.label, m.icon, m.sort);

    // Actions per module
    const actions = ['view','create','edit','delete','share','manage_permissions'];
    const insAct = db.prepare('INSERT OR IGNORE INTO module_actions (id, module_id, action, label) VALUES (?, ?, ?, ?)');
    const actionLabels = { view: 'Ver', create: 'Crear', edit: 'Editar', delete: 'Eliminar', share: 'Compartir', manage_permissions: 'Gestionar permisos' };
    for (const m of modules) {
      for (const a of actions) {
        insAct.run(`${m.id}_${a}`, m.id, a, actionLabels[a]);
      }
    }
  }

  // ── SEED PERMISSIONS FOR ADMIN ──────────────────────
  const adminPermCount = db.prepare('SELECT COUNT(*) as cnt FROM role_permissions WHERE role_id = ?').get('role-admin').cnt;
  if (adminPermCount === 0) {
    const allModules = db.prepare('SELECT id FROM modules').all();
    const insRP = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, module_id, actions) VALUES (?, ?, ?)');
    for (const m of allModules) {
      // Admin gets all actions
      const allActs = db.prepare('SELECT action FROM module_actions WHERE module_id = ?').all(m.id);
      const actionsJson = JSON.stringify(allActs.map(a => a.action));
      insRP.run('role-admin', m.id, actionsJson);
    }
  }

  // ── SEED PERMISSIONS FOR COLLABORATOR (view only) ──
  const colPermCount = db.prepare('SELECT COUNT(*) as cnt FROM role_permissions WHERE role_id = ?').get('role-collaborator').cnt;
  if (colPermCount === 0) {
    const allModules = db.prepare('SELECT id FROM modules').all();
    const insRP = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, module_id, actions) VALUES (?, ?, ?)');
    for (const m of allModules) {
      insRP.run('role-collaborator', m.id, JSON.stringify(['view']));
    }
  }

  // ── SEED DEFAULT ADMIN USER ─────────────────────────
  const adminCount = db.prepare("SELECT COUNT(*) as cnt FROM collaborators WHERE id = 'col-admin'").get().cnt;
  if (adminCount === 0) {
    const defaultHash = bcrypt.hashSync('admin123', 12);
    db.prepare(`INSERT INTO collaborators (id, name, last_name, email, password_hash, role_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run('col-admin', 'Admin', 'HADADANZA', 'admin@hadadanza.com', defaultHash, 'role-admin', 'Activo');
  }

  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

function closeDb() {
  if (db) { db.close(); db = null; }
}

module.exports = { initDatabase, getDb, closeDb };
