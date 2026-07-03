require('dotenv').config();

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
    tokenEncryptionKey: process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1',
  },
};

module.exports = config;
