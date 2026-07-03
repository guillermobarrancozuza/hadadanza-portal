const express = require('express');
const { getDb } = require('../db/sqlite');
const { requireAuth, getUserPermissions } = require('../middleware/auth');
const { logAudit } = require('../middleware/audit');
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Store uploaded template files in storage/templates/
const TEMPLATE_FILES_DIR = path.join(__dirname, '..', 'storage', 'templates');
if (!fs.existsSync(TEMPLATE_FILES_DIR)) {
  fs.mkdirSync(TEMPLATE_FILES_DIR, { recursive: true });
}

// Multer config — store files to disk, keep original extension
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMPLATE_FILES_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = 'tmpl-' + Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.doc', '.docx', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos .doc, .docx o .pdf'));
    }
  }
});

// ── HELPER: extract text from uploaded file ────────────
async function extractContent(filePath, ext) {
  try {
    if (ext === '.docx') {
      const result = await mammoth.convertToHtml({ path: filePath });
      return result.value; // HTML string
    } else if (ext === '.doc') {
      // .doc (old format) — mammoth may not support it well, try anyway
      const result = await mammoth.convertToHtml({ path: filePath });
      return result.value;
    } else if (ext === '.pdf') {
      const buf = fs.readFileSync(filePath);
      const data = await pdfParse(buf);
      const text = data.text || '';
      // Wrap in basic HTML paragraphs
      return text.split(/\n\s*\n/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
    }
    return '';
  } catch (e) {
    console.error('Extract content error:', e.message);
    return '';
  }
}

// ── HELPER: check template permission ─────────────────
function canManageTemplates(userId) {
  const perms = getUserPermissions(userId);
  const settings = perms['settings'] || [];
  return settings.includes('create') || settings.includes('edit') || settings.includes('delete');
}

// ── LIST TEMPLATES (exclude file_data binary) ─────────
router.get('/', requireAuth, (req, res) => {
  try {
    const db = getDb();
    let sql = 'SELECT id, name, description, type, category, content, file_name, file_type, is_active, created_by, created_at, updated_at FROM templates WHERE is_active = 1';
    const params = [];
    
    if (req.query.type) {
      sql += ' AND type = ?';
      params.push(req.query.type);
    }
    if (req.query.category) {
      sql += ' AND category = ?';
      params.push(req.query.category);
    }
    if (req.query.search) {
      sql += ' AND (name LIKE ? OR description LIKE ?)';
      params.push(`%${req.query.search}%`, `%${req.query.search}%`);
    }
    sql += ' ORDER BY category, name';
    
    const templates = db.prepare(sql).all(...params);
    res.json({ success: true, templates });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── LIST CATEGORIES ──────────────────────────────────
router.get('/categories/list', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const cats = db.prepare('SELECT DISTINCT category FROM templates WHERE is_active = 1 ORDER BY category').all();
    res.json({ success: true, categories: cats.map(c => c.category) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET SINGLE TEMPLATE ──────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const template = db.prepare('SELECT id, name, description, type, category, content, file_name, file_type, is_active, created_by, created_at, updated_at FROM templates WHERE id = ?').get(req.params.id);
    if (!template) return res.status(404).json({ error: 'Plantilla no encontrada' });
    res.json({ success: true, template });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DOWNLOAD ORIGINAL FILE ───────────────────────────
router.get('/:id/file', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const template = db.prepare('SELECT id, file_name, file_type, file_data FROM templates WHERE id = ?').get(req.params.id);
    if (!template || !template.file_data) {
      return res.status(404).json({ error: 'Archivo no encontrado' });
    }
    const contentType = template.file_type === '.pdf' ? 'application/pdf'
      : template.file_type === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : template.file_type === '.doc' ? 'application/msword'
      : 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${template.file_name}"`);
    res.send(template.file_data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CREATE TEMPLATE ──────────────────────────────────
router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!canManageTemplates(req.session.userId)) {
      return res.status(403).json({ error: 'Sin permisos para crear plantillas' });
    }
    const db = getDb();
    const { name, type, category, description } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'Nombre y tipo requeridos' });

    let content = req.body.content || '';
    let fileName = '';
    let fileType = '';
    let fileData = null;

    // If a file was uploaded, extract content and store the file
    if (req.file) {
      fileName = req.file.originalname;
      fileType = path.extname(req.file.originalname).toLowerCase();
      fileData = fs.readFileSync(req.file.path);
      // Extract content from the file
      const extracted = await extractContent(req.file.path, fileType);
      if (extracted) content = extracted;
      // Remove temp file — we have it in DB as BLOB
      try { fs.unlinkSync(req.file.path); } catch(e) {}
    }

    const id = 'tmpl-' + Date.now();
    db.prepare(`INSERT INTO templates (id, name, description, type, category, content, file_name, file_type, file_data, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, name, description || '', type, category || 'General', content, fileName, fileType, fileData, req.session.userId);
    
    logAudit(req, 'template_created', 'template', id, null, { name, type, category, file: fileName });
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── UPDATE TEMPLATE ──────────────────────────────────
router.put('/:id', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!canManageTemplates(req.session.userId)) {
      return res.status(403).json({ error: 'Sin permisos para editar plantillas' });
    }
    const db = getDb();
    const existing = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Plantilla no encontrada' });

    const name = req.body.name ?? existing.name;
    const description = req.body.description ?? existing.description;
    const type = req.body.type ?? existing.type;
    const category = req.body.category ?? existing.category;
    let content = req.body.content !== undefined ? req.body.content : existing.content;
    let fileName = existing.file_name;
    let fileType = existing.file_type;
    let fileData = existing.file_data;

    // If a new file was uploaded, replace existing
    if (req.file) {
      fileName = req.file.originalname;
      fileType = path.extname(req.file.originalname).toLowerCase();
      fileData = fs.readFileSync(req.file.path);
      const extracted = await extractContent(req.file.path, fileType);
      if (extracted) content = extracted;
      try { fs.unlinkSync(req.file.path); } catch(e) {}
    }

    db.prepare(`UPDATE templates SET name = ?, description = ?, type = ?, category = ?,
      content = ?, file_name = ?, file_type = ?, file_data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(name, description, type, category, content, fileName, fileType, fileData, req.params.id);
    
    logAudit(req, 'template_updated', 'template', req.params.id, existing, { name, type, category, file: fileName });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE TEMPLATE ──────────────────────────────────
router.delete('/:id', requireAuth, (req, res) => {
  try {
    if (!canManageTemplates(req.session.userId)) {
      return res.status(403).json({ error: 'Sin permisos para eliminar plantillas' });
    }
    const db = getDb();
    const existing = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Plantilla no encontrada' });
    
    db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
    logAudit(req, 'template_deleted', 'template', req.params.id, existing, null);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DUPLICATE TEMPLATE ───────────────────────────────
router.post('/:id/duplicate', requireAuth, (req, res) => {
  try {
    if (!canManageTemplates(req.session.userId)) {
      return res.status(403).json({ error: 'Sin permisos' });
    }
    const db = getDb();
    const original = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
    if (!original) return res.status(404).json({ error: 'Plantilla no encontrada' });
    
    const newId = 'tmpl-' + Date.now();
    db.prepare(`INSERT INTO templates (id, name, description, type, category, content, file_name, file_type, file_data, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(newId, original.name + ' (copia)', original.description, original.type, original.category, original.content,
        original.file_name, original.file_type, original.file_data, req.session.userId);
    
    logAudit(req, 'template_duplicated', 'template', newId, null, { original: req.params.id });
    res.json({ success: true, id: newId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ASSIGN TEMPLATE TO EVENT ─────────────────────────
router.put('/assign/:eventId', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const { type, template_id } = req.body;
    if (!type || !template_id) return res.status(400).json({ error: 'type y template_id requeridos' });
    
    db.prepare('DELETE FROM template_event_assignments WHERE event_id = ? AND type = ?').run(req.params.eventId, type);
    db.prepare('INSERT INTO template_event_assignments (event_id, template_id, type) VALUES (?, ?, ?)')
      .run(req.params.eventId, template_id, type);
    
    logAudit(req, 'template_assigned', 'event', req.params.eventId, null, { template_id, type });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET EVENT ASSIGNMENTS ────────────────────────────
router.get('/assign/:eventId', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const assignments = db.prepare(`
      SELECT tea.*, t.name as template_name, t.type as template_type, t.content, t.file_name, t.file_type
      FROM template_event_assignments tea
      JOIN templates t ON tea.template_id = t.id
      WHERE tea.event_id = ?
    `).all(req.params.eventId);
    res.json({ success: true, assignments });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── REMOVE EVENT ASSIGNMENT ──────────────────────────
router.delete('/assign/:eventId/:type', requireAuth, (req, res) => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM template_event_assignments WHERE event_id = ? AND type = ?')
      .run(req.params.eventId, req.params.type);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Multer error handler ─────────────────────────────
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'El archivo excede el límite de 20MB' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err.message && err.message.includes('Solo se permiten')) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

module.exports = router;
