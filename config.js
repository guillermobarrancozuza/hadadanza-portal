require('dotenv').config();
const crypto = require('crypto');

const config = {
  port: process.env.PORT || 3000,
  sessionSecret: process.env.SESSION_SECRET || 'hadadanza-default-secret',

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackUrl: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/api/v1/auth/google/callback',
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'hadadanzametal@gmail.com',
    tokenEncryptionKey: crypto.createHash('sha256').update(process.env.SESSION_SECRET || 'hadadanza-default-secret').digest('hex'),
  },
};

module.exports = config;
