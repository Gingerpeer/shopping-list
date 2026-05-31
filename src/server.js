'use strict';

const createApp = require('./app');
const config = require('./config');

// Touch the database module so the schema is created on start-up.
require('./db');

const app = createApp();

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Shopping list app listening on http://localhost:${config.port}`);
});
