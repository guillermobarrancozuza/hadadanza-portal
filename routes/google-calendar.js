const express = require('express');
const { getDb } = require('../db/sqlite');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../middleware/audit');
const googleCal = require('../services/google-calendar');
const router = express.Router();

// GET /api/v1/auth/google — Iniciar OAuth flow (login)
router.get('/auth/google', (req, res) => {
  const mode = req.query.mode || 'login';

  if (mode === 'login') {
    // LOGIN FLOW: no session required
    const authUrl = googleCal.getLoginAuthUrl();
    return res.redirect(authUrl);
  }

  // CALENDAR CONNECT FLOW: solo admin
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const db = getDb();
  const user = db.prepare('SELECT role_id FROM collaborators WHERE id = ?').get(req.session.userId);
  if (!user || user.role_id !== 'role-admin') {
    return res.status(403).json({ error: 'Solo el administrador puede conectar el calendario' });
  }

  // Redirect to Google OAuth with calendar scope (no state needed, global)
  const oauth2 = googleCal.getOAuth2Client();
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    prompt: 'consent',
    include_granted_scopes: true,
  });
  res.redirect(authUrl);
});

// GET /api/v1/auth/google/callback — Callback de OAuth (login o calendar)
router.get('/auth/google/callback', async (req, res) => {
  const { code, error: oauthError } = req.query;
  const isLoginFlow = !req.session?.userId;

  if (oauthError) {
    console.error('Google OAuth error:', oauthError);
    return res.redirect('/?google=error&msg=' + encodeURIComponent(oauthError));
  }
  if (!code) {
    return res.redirect('/?google=error&msg=No+authorization+code');
  }

  try {
    const tokens = await googleCal.handleCallback(code);
    const email = await googleCal.getUserEmailFromTokens(tokens) || (await (async () => {
      const { OAuth2Client } = require('google-auth-library');
      const oa2 = new OAuth2Client();
      oa2.setCredentials({ access_token: tokens.access_token });
      return (await oa2.getTokenInfo(tokens.access_token)).email || 'unknown';
    })());

    if (isLoginFlow) {
      // ── LOGIN FLOW ──
      const db = getDb();
      let user = db.prepare('SELECT * FROM collaborators WHERE email = ?').get(email);

      if (!user) {
        const googleInfo = await googleCal.getUserInfo(tokens);
        const displayName = googleInfo?.name || email.split('@')[0] || 'Usuario Google';
        const givenName = googleInfo?.givenName || '';
        const familyName = googleInfo?.familyName || '';

        const newId = 'col-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        db.prepare(`
          INSERT INTO collaborators (id, name, last_name, email, role_id, status, google_account_email, google_calendar_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(newId, displayName, familyName || givenName, email, 'role-collaborator', 'Activo', email, 'disconnected');

        user = db.prepare('SELECT * FROM collaborators WHERE id = ?').get(newId);
        console.log(`✅ Auto-created collaborator: ${email} → ${displayName}`);
      }

      if (user.status !== 'Activo') {
        return res.redirect('/?google=no-access&reason=disabled');
      }

      req.session.userId = user.id;
      req.session.userName = user.name;
      req.session.userRole = user.role_id;

      db.prepare('UPDATE collaborators SET google_account_email = ?, google_calendar_status = ?, last_login_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(email, 'disconnected', user.id);

      logAudit(req, 'google_login', 'collaborator', user.id, null, { email });

      req.session.save(() => {
        res.redirect('/?google=login');
      });
    } else {
      // ── CALENDAR CONNECT FLOW (global / solo admin) ──
      if (email !== 'hadadanzametal@gmail.com' && email !== googleCal.getGlobalEmail()) {
        console.warn(`[google] Intentó conectar con email diferente: ${email}`);
      }

      // Guardar tokens como globales
      googleCal.saveGlobalTokens(tokens);
      googleCal.saveGlobalEmail(email);
      googleCal.saveGlobalSyncStatus('synced');

      logAudit(req, 'google_connected', 'system', 'global', null, { email });

      // Restore session if needed
      if (!req.session?.userId) {
        const db = getDb();
        const user = db.prepare('SELECT * FROM collaborators WHERE id = ?').get(req.query.state);
        if (user) {
          req.session.userId = user.id;
          req.session.userName = user.name;
          req.session.userRole = user.role_id;
        }
      }

      req.session.save(() => {
        res.redirect('/?google=connected');
      });
    }
  } catch (e) {
    console.error('OAuth callback error:', e);
    res.redirect('/?google=error&msg=' + encodeURIComponent(e.message));
  }
});

// GET /api/v1/google/status — Estado GLOBAL de la conexión del calendario
router.get('/google/status', requireAuth, (req, res) => {
  const status = googleCal.getGlobalSyncStatus();
  const connected = status === 'synced' || status === 'error';
  res.json({
    connected,
    status,
    email: googleCal.getGlobalEmail(),
    hasTokens: googleCal.hasGlobalTokens(),
  });
});

// POST /api/v1/google/sync — Forzar sincronización manual (admin)
router.post('/google/sync', requireAuth, async (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT role_id FROM collaborators WHERE id = ?').get(req.session.userId);
  if (!user || user.role_id !== 'role-admin') {
    return res.status(403).json({ error: 'Solo el administrador' });
  }
  if (!googleCal.hasGlobalTokens()) {
    return res.status(400).json({ error: 'Google Calendar no conectado' });
  }

  googleCal.saveGlobalSyncStatus('syncing');

  // Resync all events from db.json
  try {
    const fs = require('fs');
    const path = require('path');
    const dbData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'storage', 'db.json'), 'utf8'));
    const events = dbData.events || [];
    let synced = 0, errors = 0;

    for (const ev of events) {
      const googleEventId = ev.google_event_id || null;
      const result = await googleCal.pushEventToCalendar(ev, googleEventId);
      if (result.success) {
        if (!googleEventId) {
          // Save the new google_event_id back to db.json
          ev.google_event_id = result.googleEventId;
        }
        synced++;
      } else {
        errors++;
      }
    }

    // Write updated google_event_ids back
    if (synced > 0) {
      fs.writeFileSync(path.join(__dirname, '..', 'storage', 'db.json'), JSON.stringify(dbData, null, 2), 'utf8');
    }

    googleCal.saveGlobalSyncStatus(errors === 0 && synced >= 0 ? 'synced' : 'error');
    res.json({ success: true, synced, errors });
  } catch (e) {
    googleCal.saveGlobalSyncStatus('error');
    res.status(500).json({ error: e.message });
  }
});

// POST /api/v1/google/disconnect — Desconectar calendario global (admin)
router.post('/google/disconnect', requireAuth, async (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT role_id FROM collaborators WHERE id = ?').get(req.session.userId);
  if (!user || user.role_id !== 'role-admin') {
    return res.status(403).json({ error: 'Solo el administrador' });
  }
  try {
    await googleCal.revokeGlobalAccess();
    logAudit(req, 'google_disconnected', 'system', 'global');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router };
