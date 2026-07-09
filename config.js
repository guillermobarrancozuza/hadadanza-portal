require('dotenv').config();
const crypto = require('crypto');

const config = {
  port: process.env.PORT || 3000,
  sessionSecret: process.env.SESSION_SECRET || 'hadadanza-default-secret',

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackUrl: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/api/v1/auth/google/callback',
    scopes: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
      'openid',
      'email',
    ],
    tokenEncryptionKey: process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || crypto.createHash('sha256').update(process.env.SESSION_SECRET || 'hadadanza-default-secret').digest('hex'),
  },
};

module.exports = config;
