'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const listRoutes = require('./routes/lists');
const adminRoutes = require('./routes/admin');
const { ensureCsrfCookie, verifyCsrf } = require('./csrf');

/**
 * Builds and configures the Express application. Kept separate from server
 * start-up so it can be imported directly by tests.
 */
function createApp() {
  const app = express();

  // Behind a reverse proxy (e.g. on a hosting platform) trust the first proxy
  // so secure cookies and rate-limiting see the real client IP.
  app.set('trust proxy', 1);

  // Security headers. A strict Content-Security-Policy restricts resources to
  // our own origin; the frontend keeps all CSS/JS in external files so no
  // 'unsafe-inline' is required.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );

  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use(ensureCsrfCookie);

  // A broad rate limit protecting every endpoint, including the static frontend
  // and SPA fallback (the auth routes add a second, stricter limiter on top).
  // Disabled under test to keep the suite fast.
  if (process.env.NODE_ENV !== 'test') {
    app.use(
      rateLimit({
        windowMs: 60 * 1000,
        max: 300,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many requests. Please slow down.' },
      })
    );
  }

  // Reject forged state-changing requests for the whole API surface.
  app.use('/api', verifyCsrf);

  // API routes
  app.use('/api/auth', authRoutes);
  app.use('/api/lists', listRoutes);
  app.use('/api/admin', adminRoutes);

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // Static frontend
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // 404 for unmatched API routes
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  // SPA fallback: serve the app shell for any other GET request.
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  // Centralised error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // eslint-disable-next-line no-console
    console.error('[error]', err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'An unexpected error occurred.' });
  });

  return app;
}

module.exports = createApp;
