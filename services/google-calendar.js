const { google } = require('googleapis');
const crypto = require('crypto');
const { getDb } = require('../db/sqlite');
const config = require('../config');

// ── STATUS → COLOR MAP (Google Calendar colorId) ─────
const STATUS_COLOR_MAP = {
  confirmed: 10,    // Green
  reserve:    1,    // Blue
  option:     6,    // Orange
  cancelled:  8,    // Gray
  band_work:  3,    // Purple
  holidays:  11,    // Red
  conflict:   4,    // Flamingo/Gold
};
const DEFAULT_COLOR_ID = 8; // Gray

// ── STATUS → EMOJI MAP (para Google Calendar summary) ─
const STATUS_EMOJI_MAP = {
  confirmed: '🟢',
  reserve:   '🔵',
  option:    '🟡',
  cancelled: '⚫',
  band_work: '🟣',
  holidays:  '🔴',
  conflict:  '🟠',
};

function getStatusEmoji(status) {
  return STATUS_EMOJI_MAP[status] || '⚪';
}

function getColorId(status) {
  return STATUS_COLOR_MAP[status] ?? DEFAULT_COLOR_ID;
}

// ── AES-256-GCM ENCRYPTION ─────────────────────────
function encrypt(text) {
  const key = Buffer.from(config.google.tokenEncryptionKey, 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return JSON.stringify({ iv: iv.toString('hex'), encrypted, tag: cipher.getAuthTag().toString('hex') });
}

function decrypt(encryptedJson) {
  try {
    const { iv, encrypted, tag } = JSON.parse(encryptedJson);
    const key = Buffer.from(config.google.tokenEncryptionKey, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('Token decryption failed:', e.message);
    return null;
  }
}

// ── OAUTH2 CLIENT ──────────────────────────────────
function getOAuth2Client() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.callbackUrl
  );
}

// ── LOGIN SCOPES (minimal) ─────────────────────────
function getLoginAuthUrl() {
  const oauth2 = getOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'],
    prompt: 'consent',
    include_granted_scopes: true,
  });
}

async function handleCallback(code) {
  const oauth2 = getOAuth2Client();
  const { tokens } = await oauth2.getToken(code);
  return tokens;
}

async function getUserEmailFromTokens(tokens) {
  try {
    const { OAuth2Client } = require('google-auth-library');
    const oauth2 = new OAuth2Client();
    oauth2.setCredentials({ access_token: tokens.access_token });
    const tokenInfo = await oauth2.getTokenInfo(tokens.access_token);
    return tokenInfo.email || null;
  } catch { return null; }
}

async function getUserInfo(tokens) {
  try {
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({ access_token: tokens.access_token });
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    return {
      email: data.email || null,
      name: data.name || data.given_name || data.email || 'Usuario Google',
      givenName: data.given_name || '',
      familyName: data.family_name || '',
      picture: data.picture || null,
    };
  } catch {
    return null;
  }
}

// ── GLOBAL TOKEN STORAGE (app_config) ─────────────
function saveGlobalTokens(tokens) {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `);
  upsert.run('google_access_token', encrypt(tokens.access_token));
  upsert.run('google_refresh_token', tokens.refresh_token ? encrypt(tokens.refresh_token) : '');
  upsert.run('google_token_expiry', tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : '');
  upsert.run('google_scope', tokens.scope || '');
}

function getGlobalTokens() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM app_config WHERE key LIKE ?').all('google_%');
  if (!rows.length) return null;
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (!map.google_access_token) return null;
  const accessToken = decrypt(map.google_access_token);
  if (!accessToken) return null;
  return {
    access_token: accessToken,
    refresh_token: map.google_refresh_token ? decrypt(map.google_refresh_token) : null,
    expiry_date: map.google_token_expiry ? new Date(map.google_token_expiry).getTime() : null,
    scope: map.google_scope || '',
  };
}

function deleteGlobalTokens() {
  const db = getDb();
  db.prepare("DELETE FROM app_config WHERE key LIKE 'google_%'").run();
}

function saveGlobalEmail(email) {
  const db = getDb();
  db.prepare(`
    INSERT INTO app_config (key, value, updated_at) VALUES ('google_account_email', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(email);
}

function getGlobalEmail() {
  const db = getDb();
  const row = db.prepare("SELECT value FROM app_config WHERE key = 'google_account_email'").get();
  return row?.value || null;
}

function saveGlobalSyncStatus(status) {
  const db = getDb();
  db.prepare(`
    INSERT INTO app_config (key, value, updated_at) VALUES ('google_sync_status', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(status);
}

function getGlobalSyncStatus() {
  const db = getDb();
  const row = db.prepare("SELECT value FROM app_config WHERE key = 'google_sync_status'").get();
  return row?.value || 'disconnected';
}

function hasGlobalTokens() {
  const tokens = getGlobalTokens();
  return !!(tokens?.access_token);
}

// ── AUTHENTICATED GLOBAL CLIENT ────────────────────
async function getAuthenticatedGlobalClient() {
  const tokens = getGlobalTokens();
  if (!tokens || !tokens.access_token) return null;

  const oauth2 = getOAuth2Client();
  oauth2.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
  });

  // Auto-refresh if expired
  oauth2.on('tokens', (newTokens) => {
    if (newTokens.access_token || newTokens.refresh_token) {
      const existing = getGlobalTokens();
      saveGlobalTokens({
        access_token: newTokens.access_token || tokens.access_token,
        refresh_token: newTokens.refresh_token || existing?.refresh_token || tokens.refresh_token,
        expiry_date: newTokens.expiry_date || tokens.expiry_date,
        scope: tokens.scope,
      });
    }
  });

  // Force refresh if token is expired
  const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date).getTime() : 0;
  if (Date.now() >= expiresAt - 300000) { // 5 min buffer
    try {
      const { credentials } = await oauth2.refreshAccessToken();
      saveGlobalTokens({
        access_token: credentials.access_token,
        refresh_token: credentials.refresh_token || tokens.refresh_token,
        expiry_date: credentials.expiry_date,
        scope: tokens.scope,
      });
    } catch (e) {
      console.error('Token refresh failed:', e.message);
      return null;
    }
  }

  return google.calendar({ version: 'v3', auth: oauth2 });
}

// ── CALENDAR API OPERATIONS ───────────────────────
function buildEventBody(appEvent) {
  // Build start/end datetimes
  const startDate = appEvent.start_date;
  const endDate = appEvent.end_date || appEvent.start_date;
  const showTime = appEvent.basic_info?.show_time;
  const finalStartTime = showTime ? `${showTime}:00` : '10:00:00';
  const finalEndTime = showTime
    ? (() => {
        const [h, m = 0] = showTime.split(':').map(Number);
        return `${String((h + 1) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
      })()
    : '11:00:00';

  const description = [
    `Artista: ${appEvent.artist_id || ''}`,
    `Ciudad: ${appEvent.city || ''}`,
    `Lugar: ${appEvent.venue_name || ''}`,
    `Estado: ${appEvent.status || ''}`,
    `Tipo: ${appEvent.deal_type || ''}`,
    appEvent.notes ? `Notas: ${appEvent.notes}` : null,
  ].filter(Boolean).join('\n');

  const body = {
    summary: `${getStatusEmoji(appEvent.status)} ${appEvent.title || 'Concierto'}${appEvent.venue_name ? ' — ' + appEvent.venue_name : ''}`,
    description,
    location: `${appEvent.venue_name || ''}, ${appEvent.city || ''}, ${appEvent.country_code || ''}`,
    colorId: String(DEFAULT_COLOR_ID),
    start: { dateTime: `${startDate}T${finalStartTime}`, timeZone: 'Europe/Madrid' },
    end: { dateTime: `${endDate}T${finalEndTime}`, timeZone: 'Europe/Madrid' },
  };

  return body;
}

async function pushEventToCalendar(appEvent, googleEventId = null) {
  const calendar = await getAuthenticatedGlobalClient();
  if (!calendar) return { success: false, error: 'Not authenticated' };

  const eventBody = buildEventBody(appEvent);
  const calendarId = config.google.calendarId;

  try {
    let result;
    if (googleEventId) {
      result = await calendar.events.update({
        calendarId,
        eventId: googleEventId,
        requestBody: eventBody,
      });
    } else {
      result = await calendar.events.insert({
        calendarId,
        requestBody: eventBody,
      });
    }
    return { success: true, googleEventId: result.data.id };
  } catch (e) {
    const statusCode = e.response?.status || 0;
    const apiError = e.response?.data?.error;
    console.error(`Google Calendar push error [${statusCode}]:`, e.message);
    console.error('  CalendarId:', calendarId);
    console.error('  Status:', appEvent.status);
    if (apiError) {
      console.error('  API error:', JSON.stringify(apiError));
      if (apiError.errors) {
        apiError.errors.forEach((err, i) => console.error(`    [${i}] ${err.reason}: ${err.message} (domain: ${err.domain})`));
      }
    }
    return { success: false, error: e.message, statusCode, apiError: apiError?.message };
  }
}

async function deleteEventFromCalendar(googleEventId) {
  const calendar = await getAuthenticatedGlobalClient();
  if (!calendar) return { success: false, error: 'Not authenticated' };

  try {
    await calendar.events.delete({
      calendarId: config.google.calendarId,
      eventId: googleEventId,
    });
    return { success: true };
  } catch (e) {
    const statusCode = e.response?.status || 0;
    const apiError = e.response?.data?.error;
    console.error(`Google Calendar delete error [${statusCode}]:`, e.message);
    console.error('  EventId:', googleEventId);
    if (apiError) {
      console.error('  API error:', JSON.stringify(apiError));
    }
    return { success: false, error: e.message, statusCode };
  }
}

async function revokeGlobalAccess() {
  const tokens = getGlobalTokens();
  if (tokens?.access_token) {
    try {
      const oauth2 = getOAuth2Client();
      oauth2.setCredentials({ access_token: tokens.access_token });
      await oauth2.revokeToken(tokens.access_token);
    } catch (e) {
      console.error('Revoke failed:', e.message);
    }
  }
  deleteGlobalTokens();
  saveGlobalSyncStatus('disconnected');
}

module.exports = {
  getOAuth2Client,
  // Login (se mantiene)
  getLoginAuthUrl,
  handleCallback,
  getUserEmailFromTokens,
  getUserInfo,
  // Gestión global de tokens
  saveGlobalTokens,
  getGlobalTokens,
  deleteGlobalTokens,
  saveGlobalEmail,
  getGlobalEmail,
  saveGlobalSyncStatus,
  getGlobalSyncStatus,
  hasGlobalTokens,
  getAuthenticatedGlobalClient,
  // Operaciones de calendario
  pushEventToCalendar,
  deleteEventFromCalendar,
  revokeGlobalAccess,
  // Colores / Emojis
  getColorId,
  STATUS_COLOR_MAP,
  STATUS_EMOJI_MAP,
  getStatusEmoji,
};
