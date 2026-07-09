const { google } = require('googleapis');
const crypto = require('crypto');
const { getDb } = require('../db/sqlite');
const config = require('../config');

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

function getAuthUrl() {
  const oauth2 = getOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: config.google.scopes,
    prompt: 'consent', // Force refresh token on first auth
  });
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

function getCalendarAuthUrl(emailHint, state) {
  const oauth2 = getOAuth2Client();
  const params = {
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    include_granted_scopes: true,
    prompt: '',
  };
  if (emailHint) params.login_hint = emailHint;
  if (state) params.state = state;
  return oauth2.generateAuthUrl(params);
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
    const { google } = require('googleapis');
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

function getUserGrantedScopes(userId) {
  const db = getDb();
  const row = db.prepare('SELECT scope FROM google_tokens WHERE user_id = ?').get(userId);
  return row?.scope || '';
}

function hasCalendarScope(userId) {
  const scope = getUserGrantedScopes(userId);
  return scope.includes('calendar');
}


async function handleCallback(code) {
  const oauth2 = getOAuth2Client();
  const { tokens } = await oauth2.getToken(code);
  return tokens;
}

// ── TOKEN STORAGE ─────────────────────────────────
function saveTokens(userId, tokens) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO google_tokens (user_id, access_token, refresh_token, expiry_date, scope, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    userId,
    encrypt(tokens.access_token),
    tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
    tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    tokens.scope || '',
  );
}

function getTokens(userId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM google_tokens WHERE user_id = ?').get(userId);
  if (!row) return null;
  return {
    access_token: row.access_token ? decrypt(row.access_token) : null,
    refresh_token: row.refresh_token ? decrypt(row.refresh_token) : null,
    expiry_date: row.expiry_date ? new Date(row.expiry_date).getTime() : null,
    scope: row.scope,
  };
}

function deleteTokens(userId) {
  const db = getDb();
  db.prepare('DELETE FROM google_tokens WHERE user_id = ?').run(userId);
}

// ── AUTHENTICATED CLIENT ──────────────────────────
async function getAuthenticatedClient(userId) {
  const tokens = getTokens(userId);
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
      const existing = getTokens(userId);
      saveTokens(userId, {
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
      saveTokens(userId, {
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
async function listEvents(calendar, options = {}) {
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: options.timeMin || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    timeMax: options.timeMax || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: options.maxResults || 250,
  });
  return res.data.items || [];
}

async function createCalendarEvent(calendar, eventData) {
  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: eventData.title,
      description: eventData.description || '',
      location: eventData.location || '',
      start: { dateTime: eventData.startTime, timeZone: 'Europe/Madrid' },
      end: { dateTime: eventData.endTime, timeZone: 'Europe/Madrid' },
    },
  });
  return res.data;
}

async function updateCalendarEvent(calendar, googleEventId, eventData) {
  const res = await calendar.events.update({
    calendarId: 'primary',
    eventId: googleEventId,
    requestBody: {
      summary: eventData.title,
      description: eventData.description || '',
      location: eventData.location || '',
      start: { dateTime: eventData.startTime, timeZone: 'Europe/Madrid' },
      end: { dateTime: eventData.endTime, timeZone: 'Europe/Madrid' },
    },
  });
  return res.data;
}

async function deleteCalendarEvent(calendar, googleEventId) {
  await calendar.events.delete({
    calendarId: 'primary',
    eventId: googleEventId,
  });
}

// ── SYNC ENGINE ───────────────────────────────────
async function pushEvent(userId, appEvent, googleEventId = null) {
  const calendar = await getAuthenticatedClient(userId);
  if (!calendar) return { success: false, error: 'Not authenticated' };

  const startTime = appEvent.start_date + (appEvent.basic_info?.show_time ? `T${appEvent.basic_info.show_time}:00` : 'T20:00:00');
  const endTime = appEvent.end_date || appEvent.start_date + 'T23:00:00';
  const endTimeFormatted = (appEvent.end_date || appEvent.start_date) + 'T23:00:00';

  const eventData = {
    title: `${appEvent.title || 'Concierto'} - ${appEvent.venue_name || ''} ${appEvent.city || ''}`,
    description: `Artista: ${appEvent.artist_id}\nCiudad: ${appEvent.city}\nLugar: ${appEvent.venue_name}\nEstado: ${appEvent.status}\n\nNotas: ${appEvent.notes || ''}`,
    location: `${appEvent.venue_name || ''}, ${appEvent.city || ''}`,
    startTime,
    endTime: endTimeFormatted,
  };

  try {
    let googleEvent;
    if (googleEventId) {
      googleEvent = await updateCalendarEvent(calendar, googleEventId, eventData);
    } else {
      googleEvent = await createCalendarEvent(calendar, eventData);
    }
    return { success: true, googleEventId: googleEvent.id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function pullEvents(userId) {
  const calendar = await getAuthenticatedClient(userId);
  if (!calendar) return { success: false, error: 'Not authenticated' };

  try {
    const items = await listEvents(calendar);
    return { success: true, events: items };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function removeFromGoogle(userId, googleEventId) {
  const calendar = await getAuthenticatedClient(userId);
  if (!calendar) return { success: false, error: 'Not authenticated' };
  try {
    await deleteCalendarEvent(calendar, googleEventId);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── DISCONNECT ────────────────────────────────────
async function revokeAccess(userId) {
  const tokens = getTokens(userId);
  if (tokens?.access_token) {
    try {
      const oauth2 = getOAuth2Client();
      oauth2.setCredentials({ access_token: tokens.access_token });
      await oauth2.revokeToken(tokens.access_token);
    } catch (e) {
      console.error('Revoke failed:', e.message);
    }
  }
  deleteTokens(userId);
  const db = getDb();
  db.prepare(`
    UPDATE collaborators SET google_calendar_status = 'disconnected', google_account_email = NULL, last_sync_at = NULL
    WHERE id = ?
  `).run(userId);
}

module.exports = {
  getAuthUrl,
  getLoginAuthUrl,
  getCalendarAuthUrl,
  handleCallback,
  saveTokens,
  getTokens,
  deleteTokens,
  getAuthenticatedClient,
  pushEvent,
  pullEvents,
  removeFromGoogle,
  revokeAccess,
  listEvents,
  getUserEmailFromTokens,
  getUserInfo,
  hasCalendarScope,
  getUserGrantedScopes,
};
