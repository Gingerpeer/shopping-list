# Keepish — A Secure Shopping List App

Keepish is a Google Keep–inspired shopping list web app. It lets people keep
colourful, checkable shopping lists, sign in securely from anywhere with their
phone number, and collaborate by simply sharing a list with another person's
phone number. Access to the app is gated by an administrator approval workflow.

![Keepish stack](https://img.shields.io/badge/stack-Node.js%20%7C%20Express%20%7C%20PostgreSQL-informational)

## Features

- **Google Keep–style UI** — masonry cards, ten note colours, inline editing,
  checkable items, search, and an "add a list" composer.
- **Phone-number authentication** — accounts are identified by phone number and
  protected with a password of at least 8 characters.
- **Admin approval workflow** — new accounts start as `pending`. An administrator
  approves or declines them from a dedicated admin portal before they can use the
  app.
- **Per-user data isolation** — every list belongs to a user and is only visible
  to its owner and the collaborators it has been shared with.
- **Effortless collaboration** — share a list by typing a collaborator's phone
  number; they instantly see and edit it from their own account.

## Security

- Passwords are hashed with **bcrypt** (cost factor 12); plaintext is never stored.
- Sessions use **signed JWTs** delivered in an **HttpOnly, SameSite=Strict** cookie
  (marked `Secure` in production).
- The authoritative user record (role/status) is re-checked on every request, so
  declining or demoting a user takes effect immediately.
- **Helmet** sets a strict Content-Security-Policy (no inline scripts/styles) and
  other hardening headers.
- All database access uses **parameterised statements** (no string-built SQL).
- Authentication endpoints are **rate limited** to slow brute-force attacks.
- Login responses are deliberately generic to avoid revealing which phone numbers
  are registered.

## Getting started

### Prerequisites

- Node.js 18+ (developed against Node 24)
- A PostgreSQL 14+ database (local install, Docker, or a managed service)

### Install & run

```bash
npm install
cp .env.example .env        # then edit values (see below)
npm start                   # http://localhost:3000
```

`npm start` connects to the database in `DATABASE_URL` and creates the schema on
first boot. The fastest way to get a database is the bundled Docker stack (see
[Running with Docker](#running-with-docker)).

For local development with auto-reload:

```bash
npm run dev
```

### Configuration (`.env`)

| Variable         | Description                                                        |
| ---------------- | ------------------------------------------------------------------ |
| `PORT`           | HTTP port (default `3000`).                                        |
| `JWT_SECRET`     | Secret used to sign session tokens. **Required in production.**    |
| `JWT_EXPIRES_IN` | Session lifetime (default `7d`).                                   |
| `DATABASE_URL`   | PostgreSQL connection string. **Required in production.**          |
| `DATABASE_SSL`   | Set `true` to require TLS for the DB connection (default `false`). |
| `ADMIN_PHONE`    | Optional. Restricts which phone bootstraps the first admin account.|
| `NODE_ENV`       | Set to `production` to enable secure cookies and strict secrets.   |

Generate a strong secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Bootstrapping the first administrator

The **first account to register** is automatically approved and granted the
`admin` role. If `ADMIN_PHONE` is set, only that phone number can claim the
bootstrap admin slot. Subsequent users register as `pending` and must be approved
from the **Admin** tab.

## Running tests

```bash
npm test
```

The suite (`test/api.test.js`) runs the full HTTP API against a PostgreSQL
database and covers registration, the approval workflow, role enforcement,
per-user data isolation, and collaboration.

The tests need a reachable PostgreSQL instance. Point them at one with
`DATABASE_URL` (or `TEST_DATABASE_URL`); they reset their own tables on start:

```bash
# e.g. using the docker-compose database service
docker compose up -d db
TEST_DATABASE_URL=******localhost:5432/shopping npm test
```

## API overview

| Method & path                              | Auth         | Description                          |
| ------------------------------------------ | ------------ | ----------------------------------- |
| `POST /api/auth/register`                  | public       | Create an account (pending).        |
| `POST /api/auth/login`                     | public       | Sign in (approved users only).      |
| `POST /api/auth/logout`                    | public       | Clear the session.                  |
| `GET  /api/auth/me`                        | session      | Current user.                       |
| `GET  /api/lists`                          | approved     | Lists owned by or shared with you.  |
| `POST /api/lists`                          | approved     | Create a list (with optional items).|
| `PATCH /api/lists/:id`                     | owner/collab | Update title / colour / archived.   |
| `DELETE /api/lists/:id`                    | owner        | Delete a list.                      |
| `POST /api/lists/:id/items`                | owner/collab | Add an item.                        |
| `PATCH /api/lists/:id/items/:itemId`       | owner/collab | Edit / check an item.               |
| `DELETE /api/lists/:id/items/:itemId`      | owner/collab | Delete an item.                     |
| `POST /api/lists/:id/share`                | owner        | Share with a phone number.          |
| `DELETE /api/lists/:id/share/:userId`      | owner/self   | Remove a collaborator / leave list. |
| `GET  /api/admin/users`                    | admin        | List all accounts.                  |
| `POST /api/admin/users/:id/decision`       | admin        | `approve` or `decline` a user.      |

## Project structure

```
src/
  app.js          Express app wiring + security middleware
  server.js       Start-up entry point
  config.js       Validated environment configuration
  db.js           PostgreSQL pool, schema, and query helpers
  auth.js         JWT issuing, cookies, auth/role middleware
  validators.js   Phone & password validation/normalisation
  routes/
    auth.js       register / login / logout / me
    lists.js      lists, items, and collaboration
    admin.js      user approval portal
public/
  index.html      App shell (auth screen, lists view, admin view)
  styles.css      Google Keep–inspired styling
  app.js          Frontend SPA logic
test/
  api.test.js     End-to-end API tests
```

## Running with Docker

A `docker-compose.yml` brings up the app together with a **separate** PostgreSQL
service, mirroring the production topology (a Node service + a managed database):

```bash
docker compose up --build      # http://localhost:3000
```

The compose file wires the app to the database via `DATABASE_URL`. Set a real
`JWT_SECRET` (and optionally `ADMIN_PHONE`) in your environment before running it
for anything beyond local experimentation:

```bash
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))") \
  docker compose up --build
```

To build and run only the application image (against your own database):

```bash
docker build -t keepish .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL=******host:5432/dbname \
  -e JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))") \
  keepish
```

## Deploying to Railway

The app is a single Node process serving both the API and the static frontend,
and it stores all state in PostgreSQL — so it deploys cleanly to Railway.

1. **Create the database.** In your Railway project, add a **PostgreSQL** service
   (New → Database → Add PostgreSQL). Railway exposes its connection string as the
   `DATABASE_URL` variable on that service.
2. **Create the app service.** Add a service from this repository. Railway detects
   the `Dockerfile` (and `railway.json`) and builds the container automatically.
3. **Set variables** on the app service:
   - `DATABASE_URL` → reference the database, e.g. `${{ Postgres.DATABASE_URL }}`.
   - `JWT_SECRET` → a long random value (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`).
   - `NODE_ENV` → `production`.
   - `ADMIN_PHONE` → optional, to lock down the bootstrap admin account.
   - Railway injects `PORT` automatically; the app reads it.
4. **Deploy.** On boot the app creates its schema, and the
   `/api/health` endpoint (configured in `railway.json`) is used for health checks.
   Because TLS is terminated by Railway's edge, the `Secure` session cookies work
   over the provided HTTPS domain.

> If you connect to a Postgres endpoint that requires TLS (for example a public
> proxy rather than Railway's private network), set `DATABASE_SSL=true`.

## License

MIT
