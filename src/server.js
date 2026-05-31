'use strict';

const createApp = require('./app');
const config = require('./config');
const db = require('./db');

async function start() {
  // Ensure the schema exists before the server accepts any traffic.
  await db.init();

  const app = createApp();

  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Shopping list app listening on http://localhost:${config.port}`);
  });
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[startup] failed to start application', err);
  process.exit(1);
});
