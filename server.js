const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');
const fs = require('fs');
const path = require('path');

require('dotenv').config();
const config = require('./config');
const { initDatabase, getDb } = require('./db/sqlite');
const { requireAuth } = require('./middleware/auth');
const cron = require('node-cron');

// ── APP SETUP ────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'storage', 'db.json');
const STORAGE_DIR = path.join(__dirname, 'storage');

if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

// ── MIDDLEWARE ────────────────────────────────────────
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// Express Session
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

// ── DATABASE ──────────────────────────────────────────
// Initialize SQLite (auth, permissions, audit)
initDatabase();

// ── DB HELPERS (remain unchanged for business data) ──
function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (err) {
    // Fallback: try root db.json (for Railway migration)
    const oldPath = path.join(__dirname, 'db.json');
    try {
      if (fs.existsSync(oldPath)) {
        const data = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
        writeDb(data); // migrate to storage/
        return data;
      }
    } catch (_) { /* ignore */ }
    return { artists: [], events: [], crew: [], collaborators: [], contacts: [], task_templates: [], contract_templates: [], files: [], subscriptions: {} };
  }
}
function writeDb(data) {
  try {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  }
  catch (err) { console.error('writeDb error:', err.message); return false; }
}

// ── SYNC QUEUE HELPER ──────────────────────────────
function enqueueSync(eventId, action) {
  try {
    const db = getDb();
    const users = db.prepare("SELECT id FROM collaborators WHERE google_calendar_status IN ('synced','error')").all();
    const ins = db.prepare('INSERT INTO sync_queue (user_id, event_id, action) VALUES (?, ?, ?)');
    for (const u of users) {
      ins.run(u.id, eventId, action);
    }
  } catch (e) { console.error('Enqueue sync error:', e.message); }
}

// ── AUTH ROUTES ──────────────────────────────────────
const authRoutes = require('./routes/auth');
app.use('/api/v1/auth', authRoutes);

// ── MODULES / ROLES / COLLABORATORS API ─────────────
const modulesRoutes = require('./routes/modules');
app.use('/api/v1/modules', modulesRoutes);
const rolesRoutes = require('./routes/roles');
app.use('/api/v1/roles', rolesRoutes);
const collaboratorsRoutes = require('./routes/collaborators');
app.use('/api/v1/collaborators', collaboratorsRoutes);

// ── GOOGLE CALENDAR ──────────────────────────────────
const { router: googleCalendarRoutes, performSync } = require('./routes/google-calendar');
app.use('/api/v1', googleCalendarRoutes);

const templatesRoutes = require('./routes/templates');
app.use('/api/v1/templates', templatesRoutes);

// ── ARTISTS ──────────────────────────────────────────
app.get('/api/v1/artists', requireAuth, (req, res) => res.json({ artists: readDb().artists }));
app.get('/api/v1/artists/:id', requireAuth, (req, res) => res.json({ artist: readDb().artists.find(a => a.id === req.params.id) }));
app.put('/api/v1/artists/:id', requireAuth, (req, res) => {
  const db = readDb(); const index = db.artists.findIndex(a => a.id === req.params.id);
  if (index !== -1) { db.artists[index] = { ...db.artists[index], ...req.body }; writeDb(db); res.json({ success: true, artist: db.artists[index] }); }
  else { res.status(404).json({ error: 'Artist not found' }); }
});
app.post('/api/v1/artists', requireAuth, (req, res) => {
  const db = readDb(); const newArtist = { id: 'art-' + Date.now(), name: req.body.name || 'Nuevo Artista', image_url: req.body.image_url || 'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=150&auto=format&fit=crop&q=60', currency: req.body.currency || 'EUR' };
  db.artists.push(newArtist); db.subscriptions[newArtist.id] = false; writeDb(db); res.status(201).json({ success: true, artist: newArtist });
});
app.post('/api/v1/artists/:id/image', requireAuth, (req, res) => {
  const db = readDb(); const index = db.artists.findIndex(a => a.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Artist not found' });
  const safeName = 'artist_' + req.params.id + '_' + Date.now() + '.jpg';
  try {
    fs.writeFileSync(path.join(STORAGE_DIR, safeName), Buffer.from(req.body.base64, 'base64'));
    const newUrl = '/api/v1/storage/' + safeName;
    db.artists[index].image_url = newUrl; writeDb(db); res.json({ success: true, image_url: newUrl });
  } catch (err) { res.status(500).json({ error: 'Failed to save image' }); }
});

app.get('/api/v1/storage/:filename', (req, res) => {
  const p = path.join(STORAGE_DIR, req.params.filename);
  if (fs.existsSync(p)) res.sendFile(p); else res.status(404).send('Not found');
});

// ── GLOBAL MODULES ──────────────────────────────────
app.get('/api/v1/crew', requireAuth, (req, res) => res.json({ crew: readDb().crew || [] }));
app.post('/api/v1/crew', requireAuth, (req, res) => {
  const db = readDb();
  const newCrew = { id: 'cr-' + Date.now(), name: req.body.name || 'Nuevo miembro', role: req.body.role || '', type: req.body.type || 'Fijo', phone: req.body.phone || '', email: req.body.email || '', birthdate: req.body.birthdate || '', dni: req.body.dni || '', passport: req.body.passport || '', diet: req.body.diet || '', rooming: req.body.rooming || '' };
  db.crew.push(newCrew); writeDb(db); res.status(201).json({ success: true, crew: newCrew });
});
app.put('/api/v1/crew/:id', requireAuth, (req, res) => {
  const db = readDb(); const index = db.crew.findIndex(c => c.id === req.params.id);
  if (index !== -1) { db.crew[index] = { ...db.crew[index], ...req.body }; writeDb(db); res.json({ success: true, crew: db.crew[index] }); }
  else res.status(404).json({ error: 'Crew member not found' });
});
app.delete('/api/v1/crew/:id', requireAuth, (req, res) => {
  const db = readDb(); const index = db.crew.findIndex(c => c.id === req.params.id);
  if (index !== -1) { const deleted = db.crew.splice(index, 1)[0]; writeDb(db); res.json({ success: true, crew: deleted }); }
  else res.status(404).json({ error: 'Crew member not found' });
});

// NOTE: Collaborators API is now served from SQLite via routes.
// The db.json collaborators list is no longer the source of truth.
// We keep a read-only GET for backward compatibility during migration.
app.get('/api/v1/collaborators', requireAuth, (req, res) => {
  const db = getDb();
  const cols = db.prepare(`
    SELECT c.id, c.name, c.email, c.status, c.role_id, c.google_calendar_status,
           r.name as role_name
    FROM collaborators c
    LEFT JOIN roles r ON c.role_id = r.id
    ORDER BY c.name
  `).all();
  res.json({ collaborators: cols });
});

app.get('/api/v1/contacts', requireAuth, (req, res) => res.json({ contacts: readDb().contacts || [] }));
app.get('/api/v1/task-templates', requireAuth, (req, res) => res.json({ templates: readDb().task_templates || [] }));
app.get('/api/v1/contract-templates', requireAuth, (req, res) => res.json({ templates: readDb().contract_templates || [] }));

// ── EVENTS ──────────────────────────────────────────
app.get('/api/v1/events/by-artist/:artistId', requireAuth, (req, res) => {
  res.json({ events: readDb().events.filter(e => e.artist_id === req.params.artistId) });
});

app.post('/api/v1/events', requireAuth, async (req, res) => {
  try {
    const db = readDb();
    const newEvent = {
      id: 'evt-' + Date.now(),
      artist_id: req.body.artist_id,
      title: req.body.title || 'Nuevo Concierto',
      venue_name: req.body.venue_name || '',
      city: req.body.city || '',
      country_code: req.body.country_code || 'ESP',
      start_date: req.body.start_date,
      end_date: req.body.end_date || req.body.start_date,
      status: req.body.status || 'option',
      deal_type: req.body.deal_type || 'flat_fee',
      guarantee_amount: Number(req.body.guarantee_amount) || 0,
      notes: req.body.notes || '',
      lat: req.body.lat ? Number(req.body.lat) : null,
      lng: req.body.lng ? Number(req.body.lng) : null,
      has_contract: !!req.body.has_contract,
      has_payout: !!req.body.has_payout,
      basic_info: { contact: '', company: '', phone: '', email: '', notes: '', cache: 0, conditions: '', deal_type: '', is_own_production: false, internal_booker: '', internal_production: '', show_time: '', more_artists: '', is_announced: 'Sí', ticket_type: 'Pago', attendance: '', roadmap_notes: '' },
      event_contacts: [], tasks: [], files: [], contracts: [],
      ticketing: { price: '', sales_url: '', physical_points: '', total_tickets: '', status: '', notes: '' },
      guests: { notes: '', available: 0, list: [] },
      accommodation: [],
      hospitality: { diet: '', catering: '', camerino: '', merch: '', notes: '' },
      travel: { road_manager: '', runner: '', agency_rep: '', stages: [] },
      tour_party: { members: [], vehicles: [] },
      technical: { contra_rider_status: '', contra_rider_notes: '', backline_notes: '', stage_size: '', platforms: '', stagehands: '', stage_manager: '', stage_manager_phone: '', stage_manager_email: '', sound_company: '', sound_rep: '', sound_phone: '', sound_email: '', light_rep: '', light_phone: '', light_email: '', notes: '', rider_file: null, contra_rider_files: [] },
      schedule: { notes: '', items: [] },
      accounting: { expenses: [], incomes: [], splits: [], decimals: false },
      promotion: { strategy: '', press_kit_status: '', press_kit_date: '', posters: '', poster_rep: '', shipping: '', status: '', press_contact: '', press_phone: '', press_email: '', interviews: '' }
    };
    db.events.push(newEvent);
    const written = writeDb(db);
    if (!written) { return res.status(500).json({ error: 'Error al guardar en disco' }); }
    enqueueSync(newEvent.id, 'create');
    res.status(201).json({ success: true, event: newEvent });
  } catch (e) {
    console.error('POST /api/v1/events error:', e.message);
    res.status(500).json({ error: 'Error interno del servidor', detail: e.message });
  }
});

app.put('/api/v1/events/:eventId', requireAuth, async (req, res) => {
  try {
    const db = readDb(); const index = db.events.findIndex(e => e.id === req.params.eventId);
    if (index !== -1) { db.events[index] = { ...db.events[index], ...req.body }; writeDb(db); enqueueSync(req.params.eventId, 'update'); res.json({ success: true, event: db.events[index] }); }
    else res.status(404).json({ error: 'Not found' });
  } catch (e) {
    console.error('PUT /api/v1/events error:', e.message);
    res.status(500).json({ error: 'Error interno del servidor', detail: e.message });
  }
});

app.delete('/api/v1/events/:eventId', requireAuth, (req, res) => {
  const db = readDb(); const index = db.events.findIndex(e => e.id === req.params.eventId);
  if (index !== -1) { const deletedEvent = db.events.splice(index, 1)[0]; writeDb(db); enqueueSync(req.params.eventId, 'delete'); res.json({ success: true, event: deletedEvent }); }
  else { res.status(404).json({ error: 'Event not found' }); }
});

app.post('/api/v1/events/:eventId/files/upload', requireAuth, (req, res) => {
  const db = readDb(); const eventIndex = db.events.findIndex(e => e.id === req.params.eventId);
  if (eventIndex === -1) return res.status(404).json({ error: 'Event not found' });
  const { name, type, size, base64 } = req.body;
  const fileId = 'file-' + Date.now(); const safeName = fileId + '_' + name.replace(/[^a-zA-Z0-9.\-_]/g, '');
  const eventDir = path.join(STORAGE_DIR, req.params.eventId);
  if (!fs.existsSync(eventDir)) fs.mkdirSync(eventDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(eventDir, safeName), Buffer.from(base64, 'base64'));
    const newFileEntry = { id: fileId, name: name, physical_name: safeName, uploaded_at: new Date().toISOString(), size: size, type: type };
    if(!db.events[eventIndex].files) db.events[eventIndex].files = [];
    db.events[eventIndex].files.push(newFileEntry);
    writeDb(db); res.status(201).json({ success: true, file: newFileEntry });
  } catch (err) { res.status(500).json({ error: 'Failed to write file' }); }
});

app.get('/api/v1/events/:eventId/files/download/:fileId', requireAuth, (req, res) => {
  const db = readDb(); const event = db.events.find(e => e.id === req.params.eventId);
  if(!event || !event.files) return res.status(404).json({ error: 'Not found' });
  const file = event.files.find(f => f.id === req.params.fileId);
  if (file && fs.existsSync(path.join(STORAGE_DIR, req.params.eventId, file.physical_name))) { res.download(path.join(STORAGE_DIR, req.params.eventId, file.physical_name), file.name); }
  else res.status(404).json({error: 'Not found'});
});

app.get('/api/v1/files', requireAuth, (req, res) => {
  const db = readDb();
  let allFiles = [];
  db.events.forEach(e => { if(e.files) allFiles = allFiles.concat(e.files); });
  res.json({ files: allFiles });
});

// ── AUDIT LOG ──────────────────────────────────────
app.get('/api/v1/audit-log', requireAuth, (req, res) => {
  const db = getDb();
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const offset = (page - 1) * limit;
  const logs = db.prepare(`
    SELECT a.*, c.name as user_name
    FROM audit_log a
    LEFT JOIN collaborators c ON a.user_id = c.id
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  const total = db.prepare('SELECT COUNT(*) as cnt FROM audit_log').get().cnt;
  res.json({ success: true, logs, total, page, limit });
});

// ── SPA FALLBACK ─────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── AUTO SYNC (cada 15 min en horario laboral) ─────
const googleCal = require('./services/google-calendar');
const { logAudit } = require('./middleware/audit');

async function processSyncQueue() {
  try {
    const db = getDb();
    const pending = db.prepare("SELECT DISTINCT user_id FROM sync_queue WHERE status = 'pending'").all();
    for (const row of pending) {
      const user = db.prepare("SELECT google_calendar_status FROM collaborators WHERE id = ?").get(row.user_id);
      if (user && (user.google_calendar_status === 'synced' || user.google_calendar_status === 'error')) {
        // Process via the sync engine
        await performSync(row.user_id);
      }
    }
  } catch (e) {
    console.error('Auto-sync error:', e.message);
  }
}

// Every 15 minutes during working hours (8:00-22:00)
cron.schedule('*/15 8-22 * * *', () => {
  processSyncQueue().catch(e => console.error('Cron sync error:', e));
});

// ── START ────────────────────────────────────────────
app.listen(PORT, () => console.log(`HADADANZA API Server running on port ${PORT}`));
