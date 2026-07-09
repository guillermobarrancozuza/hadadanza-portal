const express = require('express');
const { getDb } = require('../db/sqlite');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../middleware/audit');
const googleCal = require('../services/google-calendar');
const router = express.Router();

// GET /api/v1/auth/google — Iniciar OAuth flow (login o calendar)
router.get('/auth/google', (req, res) => {
  const mode = req.query.mode || 'calendar';

  if (mode === 'login') {
    // LOGIN FLOW: no session required
    const authUrl = googleCal.getLoginAuthUrl();
    return res.redirect(authUrl);
  }

  // CALENDAR SYNC FLOW: session required
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const db = getDb();
  const user = db.prepare('SELECT google_account_email FROM collaborators WHERE id = ?').get(req.session.userId);

  // Check if user already has tokens with calendar scope
  if (googleCal.hasCalendarScope(req.session.userId)) {
    // Already has calendar scope — just trigger sync
    return res.redirect('/?google=already-connected');
  }

  // Need calendar scope — use incremental auth with email hint if available
  const authUrl = googleCal.getCalendarAuthUrl(user?.google_account_email || undefined);
  req.session.pendingGoogleUserId = req.session.userId;
  req.session.save(() => {
    res.redirect(authUrl);
  });
});

// GET /api/v1/auth/google/callback — Callback de OAuth (login o calendar)
router.get('/auth/google/callback', async (req, res) => {
  const { code, error: oauthError } = req.query;
  const isLoginFlow = !req.session?.userId && !req.session?.pendingGoogleUserId;

  if (oauthError) {
    console.error('Google OAuth error:', oauthError);
    if (isLoginFlow) return res.redirect('/?google=error&msg=' + encodeURIComponent(oauthError));
    return res.redirect('/?google=error&msg=' + encodeURIComponent(oauthError));
  }

  if (!code) {
    if (isLoginFlow) return res.redirect('/?google=error&msg=No+authorization+code');
    return res.redirect('/?google=error&msg=No+authorization+code');
  }

  try {
    // Exchange code for tokens
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
        // ── AUTO-CREATE USER ──
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
      // Create session
      req.session.userId = user.id;
      req.session.userName = user.name;
      req.session.userRole = user.role_id;
      // Save tokens for potential later use (calendar sync)
      googleCal.saveTokens(user.id, tokens);
      db.prepare('UPDATE collaborators SET google_account_email = ?, google_calendar_status = ?, last_login_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(email, 'disconnected', user.id);
      logAudit(req, 'google_login', 'collaborator', user.id, null, { email });
      req.session.save(() => {
        res.redirect('/?google=login');
      });
    } else {
      // ── CALENDAR SYNC FLOW ──
      const userId = req.session.pendingGoogleUserId || req.session.userId;
      googleCal.saveTokens(userId, tokens);
      const db = getDb();
      db.prepare(`
        UPDATE collaborators SET google_account_email = ?, google_calendar_status = 'synced', last_sync_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(email, userId);
      logAudit(req, 'google_connected', 'collaborator', userId, null, { email });
      delete req.session.pendingGoogleUserId;
      req.session.save(() => {
        res.redirect('/?google=connected');
      });
    }
  } catch (e) {
    console.error('OAuth callback error:', e);
    if (isLoginFlow) return res.redirect('/?google=error&msg=' + encodeURIComponent(e.message));
    res.redirect('/?google=error&msg=' + encodeURIComponent(e.message));
  }
});

// POST /api/v1/google/request-calendar-scope — Solicitar permisos de calendario (login previo)
router.get('/google/request-calendar-scope', requireAuth, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT google_account_email FROM collaborators WHERE id = ?').get(req.session.userId);
  if (googleCal.hasCalendarScope(req.session.userId)) {
    return res.json({ success: true, message: 'Ya tienes permisos de calendario' });
  }
  const authUrl = googleCal.getCalendarAuthUrl(user?.google_account_email || undefined);
  req.session.pendingGoogleUserId = req.session.userId;
  req.session.save(() => {
    res.json({ success: true, authUrl });
  });
});

// GET /api/v1/google/status — Estado de la conexión
router.get('/google/status', requireAuth, (req, res) => {
  const db = getDb();
  const user = db.prepare(`
    SELECT google_calendar_status, google_account_email, last_sync_at
    FROM collaborators WHERE id = ?
  `).get(req.session.userId);

  const tokens = googleCal.getTokens(req.session.userId);

  res.json({
    connected: user?.google_calendar_status === 'synced' || user?.google_calendar_status === 'error',
    status: user?.google_calendar_status || 'disconnected',
    email: user?.google_account_email || null,
    lastSyncAt: user?.last_sync_at || null,
    hasTokens: !!tokens?.access_token,
    hasRefreshToken: !!tokens?.refresh_token,
  });
});

// POST /api/v1/google/sync — Sincronizar ahora (manual)
router.post('/google/sync', requireAuth, async (req, res) => {
  const db = getDb();
  const userId = req.session.userId;
  const user = db.prepare('SELECT google_calendar_status FROM collaborators WHERE id = ?').get(userId);
  if (!user || user.google_calendar_status === 'disconnected') {
    return res.status(400).json({ error: 'Google Calendar no conectado' });
  }

  db.prepare("UPDATE collaborators SET google_calendar_status = 'syncing' WHERE id = ?").run(userId);

  // Start sync in background (don't block response)
  const syncResult = await performSync(userId);

  res.json(syncResult);
});

// POST /api/v1/google/disconnect — Desconectar cuenta
router.post('/google/disconnect', requireAuth, async (req, res) => {
  try {
    await googleCal.revokeAccess(req.session.userId);
    logAudit(req, 'google_disconnected', 'collaborator', req.session.userId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SYNC ENGINE ────────────────────────────────────
async function performSync(userId) {
  const db = getDb();
  const startTime = new Date().toISOString();
  let result = { direction: 'bidirectional', status: 'success', events_synced: 0, events_created: 0, events_updated: 0, events_deleted: 0, error_message: null };

  try {
    // Step 1: PULL — get events from Google
    const pullResult = await googleCal.pullEvents(userId);
    if (!pullResult.success) {
      throw new Error('Pull failed: ' + pullResult.error);
    }

    // Step 2: Process each Google event for mapping
    const googleEvents = pullResult.events || [];
    let mapped = 0;

    for (const ge of googleEvents) {
      // Check if we already have this event mapped
      const existing = db.prepare('SELECT event_id FROM event_mapping WHERE google_event_id = ? AND user_id = ?')
        .get(ge.id, userId);

      if (existing) {
        // Already mapped, could update the local event here in the future
        mapped++;
        continue;
      }

      // New event from Google — we could auto-create it in the app
      // For now, just log it
      result.events_created++;
    }

    // Step 3: PUSH — process pending queue
    const queue = db.prepare('SELECT * FROM sync_queue WHERE user_id = ? AND status = ? ORDER BY created_at LIMIT 10')
      .all(userId, 'pending');

    for (const item of queue) {
      const eventId = item.event_id;
      const action = item.action;

      // Get the Google event ID from mapping
      const mapping = db.prepare('SELECT google_event_id FROM event_mapping WHERE event_id = ? AND user_id = ?')
        .get(eventId, userId);

      try {
        if (action === 'delete' && mapping) {
          const delResult = await googleCal.removeFromGoogle(userId, mapping.google_event_id);
          if (delResult.success) {
            db.prepare('DELETE FROM event_mapping WHERE event_id = ? AND user_id = ?').run(eventId, userId);
            result.events_deleted++;
          }
        } else if (action === 'update' || action === 'create') {
          // Get the app event
          const appEvent = getAppEvent(eventId);
          if (!appEvent) continue;

          const pushResult = await googleCal.pushEvent(userId, appEvent, mapping?.google_event_id);
          if (pushResult.success) {
            // Save/update mapping
            db.prepare(`
              INSERT OR REPLACE INTO event_mapping (event_id, user_id, google_event_id, google_calendar_id, last_sync_at, last_sync_direction)
              VALUES (?, ?, ?, 'primary', CURRENT_TIMESTAMP, 'push')
            `).run(eventId, userId, pushResult.googleEventId);
            result.events_synced++;
          }
        }

        // Mark queue item as done
        db.prepare("UPDATE sync_queue SET status = 'done' WHERE id = ?").run(item.id);
      } catch (itemError) {
        db.prepare("UPDATE sync_queue SET status = 'failed', error_message = ?, retry_count = retry_count + 1 WHERE id = ?")
          .run(itemError.message, item.id);
        result.error_message = itemError.message;
      }
    }

    // Update sync status
    db.prepare(`
      UPDATE collaborators SET google_calendar_status = 'synced', last_sync_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(userId);

  } catch (e) {
    result.status = 'error';
    result.error_message = e.message;
    db.prepare("UPDATE collaborators SET google_calendar_status = 'error' WHERE id = ?").run(userId);
  }

  // Log sync
  const completedTime = new Date().toISOString();
  db.prepare(`
    INSERT INTO sync_log (user_id, direction, status, events_synced, events_created, events_updated, events_deleted, error_message, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, result.direction, result.status, result.events_synced, result.events_created, result.events_updated, result.events_deleted, result.error_message, startTime, completedTime);

  return result;
}

// Helper: get app event from db.json
function getAppEvent(eventId) {
  try {
    const fs = require('fs');
    const path = require('path');
    const db = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'storage', 'db.json'), 'utf8'));
    return db.events?.find(e => e.id === eventId) || null;
  } catch {
    return null;
  }
}

module.exports = { router, performSync };
