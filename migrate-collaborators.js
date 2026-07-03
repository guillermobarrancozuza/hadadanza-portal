/**
 * Script de migración: colaboradores de db.json a SQLite.
 * Lee db.json, migra cada colaborador a la tabla collaborators en SQLite.
 * Preserva el id original y el modelo legacy de permisos.
 * 
 * Uso: node migrate-collaborators.js
 */

const path = require('path');
const bcrypt = require('bcrypt');
const { initDatabase, getDb, closeDb } = require('./db/sqlite');

const DB_JSON_PATH = path.join(__dirname, 'db.json');

async function migrate() {
  console.log('=== Migración de colaboradores: db.json → SQLite ===\n');

  // 1. Init SQLite
  initDatabase();
  const db = getDb();

  // 2. Read db.json
  let jsonData;
  try {
    jsonData = JSON.parse(require('fs').readFileSync(DB_JSON_PATH, 'utf8'));
  } catch (err) {
    console.error('❌ Error leyendo db.json:', err.message);
    process.exit(1);
  }

  const oldCollaborators = jsonData.collaborators || [];
  console.log(`Encontrados ${oldCollaborators.length} colaboradores en db.json\n`);

  let migrated = 0;
  let skipped = 0;

  for (const oldCol of oldCollaborators) {
    // Check if already exists in SQLite
    const existing = db.prepare('SELECT id FROM collaborators WHERE id = ?').get(oldCol.id);
    if (existing) {
      console.log(`  ⏭  ${oldCol.name} (${oldCol.id}) — ya existe, saltando`);
      skipped++;
      continue;
    }

    // Generate a default password hash (col-name)
    const defaultPassword = `${oldCol.name.toLowerCase().replace(/\s+/g, '')}123`;
    const passwordHash = bcrypt.hashSync(defaultPassword, 12);

    // Map the old nested permissions to a JSON string for reference (stored in legacy_permissions field... we'll put it in an extra field)
    // We'll store it in google_account_email temporarily? No. Let's not lose data.
    // Actually, we'll keep the old permissions reference by adding the data into a temp note. 
    // Better: store the legacy permissions snapshot in audit_log.
    
    try {
      db.prepare(`
        INSERT INTO collaborators (id, name, email, password_hash, role_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'Activo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(
        oldCol.id,
        oldCol.name,
        oldCol.email || `${oldCol.id}@hadadanza.local`,
        passwordHash,
        'role-collaborator' // default role
      );

      // Log the legacy permissions to audit
      if (oldCol.permissions) {
        const legacyPerms = oldCol.permissions;
        db.prepare(`
          INSERT INTO audit_log (user_id, action, target_type, target_id, old_value, new_value, created_at)
          VALUES ('system', 'migrated_legacy_permissions', 'collaborator', ?, NULL, ?, CURRENT_TIMESTAMP)
        `).run(oldCol.id, JSON.stringify(legacyPerms));
      }

      console.log(`  ✅ ${oldCol.name} (${oldCol.id}) — migrado. Password: ${defaultPassword}`);
      migrated++;
    } catch (err) {
      console.error(`  ❌ Error migrando ${oldCol.name}: ${err.message}`);
    }
  }

  console.log(`\n=== Resumen: ${migrated} migrados, ${skipped} omitidos ===`);
  
  // Create backup of db.json
  const fs = require('fs');
  const backupPath = path.join(__dirname, 'db.json.backup');
  fs.copyFileSync(DB_JSON_PATH, backupPath);
  console.log(`✅ Backup de db.json creado en ${backupPath}`);

  closeDb();
  console.log('\nMigración completada.');
}

migrate().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
