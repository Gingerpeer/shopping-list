'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Configure an isolated database + secret BEFORE the app modules load.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@localhost:5432/shopping_test';
process.env.JWT_SECRET = 'test-secret-value';
process.env.NODE_ENV = 'test';

const createApp = require('../src/app');
const db = require('../src/db');

let server;
let base;

test.before(async () => {
  // Start from a clean schema so the suite's sequential expectations hold.
  await db.query(
    'DROP TABLE IF EXISTS list_shares, list_items, lists, users CASCADE'
  );
  await db.init();

  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) server.close();
  await db.close();
});

/** Minimal cookie-aware request helper with CSRF double-submit support. */
function makeClient() {
  const cookies = {};
  const cookieHeader = () =>
    Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  return async function request(method, p, body) {
    // Obtain a CSRF cookie before the first state-changing request, mirroring a
    // browser that received it when loading the page.
    if (!cookies.csrf_token && !['GET', 'HEAD'].includes(method)) {
      await request('GET', '/api/health');
    }
    const headers = {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    };
    if (Object.keys(cookies).length) headers.Cookie = cookieHeader();
    if (cookies.csrf_token && !['GET', 'HEAD'].includes(method)) {
      headers['X-CSRF-Token'] = cookies.csrf_token;
    }
    const res = await fetch(base + p, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookies =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
    for (const sc of setCookies) {
      const [pair] = sc.split(';');
      const idx = pair.indexOf('=');
      cookies[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }
    return { status: res.status, data };
  };
}

test('first registered user becomes an approved admin', async () => {
  const admin = makeClient();
  const res = await admin('POST', '/api/auth/register', {
    phone: '+14155550100',
    password: 'adminpass1',
    displayName: 'Admin',
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.user.role, 'admin');
  assert.equal(res.data.user.status, 'approved');
});

test('subsequent users are pending and cannot log in until approved', async () => {
  const bob = makeClient();
  const reg = await bob('POST', '/api/auth/register', {
    phone: '+14155550111',
    password: 'bobpass12',
    displayName: 'Bob',
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.user.status, 'pending');

  const login = await bob('POST', '/api/auth/login', {
    phone: '+14155550111',
    password: 'bobpass12',
  });
  assert.equal(login.status, 403);
  assert.equal(login.data.status, 'pending');
});

test('passwords shorter than 8 characters are rejected', async () => {
  const c = makeClient();
  const res = await c('POST', '/api/auth/register', {
    phone: '+14155550122',
    password: 'short1',
  });
  assert.equal(res.status, 400);
});

test('invalid phone numbers are rejected', async () => {
  const c = makeClient();
  const res = await c('POST', '/api/auth/register', {
    phone: 'not-a-phone',
    password: 'longenough1',
  });
  assert.equal(res.status, 400);
});

test('admin can approve a user, who can then sign in and use the app', async () => {
  const admin = makeClient();
  await admin('POST', '/api/auth/login', {
    phone: '+14155550100',
    password: 'adminpass1',
  });

  const users = await admin('GET', '/api/admin/users');
  assert.equal(users.status, 200);
  const bob = users.data.users.find((u) => u.phone === '+14155550111');
  assert.ok(bob);

  const decision = await admin('POST', `/api/admin/users/${bob.id}/decision`, {
    decision: 'approve',
  });
  assert.equal(decision.status, 200);
  assert.equal(decision.data.user.status, 'approved');

  const bobClient = makeClient();
  const login = await bobClient('POST', '/api/auth/login', {
    phone: '+14155550111',
    password: 'bobpass12',
  });
  assert.equal(login.status, 200);

  const created = await bobClient('POST', '/api/lists', {
    title: 'Groceries',
    color: 'green',
    items: [{ text: 'Milk' }, { text: 'Eggs' }],
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.list.items.length, 2);
});

test('non-admins cannot access the admin API', async () => {
  const bobClient = makeClient();
  await bobClient('POST', '/api/auth/login', {
    phone: '+14155550111',
    password: 'bobpass12',
  });
  const res = await bobClient('GET', '/api/admin/users');
  assert.equal(res.status, 403);
});

test('users cannot see lists that are not theirs', async () => {
  const bobClient = makeClient();
  await bobClient('POST', '/api/auth/login', {
    phone: '+14155550111',
    password: 'bobpass12',
  });
  const lists = await bobClient('GET', '/api/lists');
  // Bob owns exactly the one list he created earlier.
  assert.equal(lists.status, 200);
  assert.equal(lists.data.lists.length, 1);
  assert.equal(lists.data.lists[0].title, 'Groceries');
});

test('state-changing requests without a CSRF token are rejected', async () => {
  // A raw request that supplies no CSRF cookie/header must be blocked.
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '+14155550100', password: 'adminpass1' }),
  });
  assert.equal(res.status, 403);
});

test('collaboration: owner shares a list and collaborator gains access', async () => {
  // Approve a third user, Carol.
  const carol = makeClient();
  await carol('POST', '/api/auth/register', {
    phone: '+14155550133',
    password: 'carolpass1',
    displayName: 'Carol',
  });
  const admin = makeClient();
  await admin('POST', '/api/auth/login', {
    phone: '+14155550100',
    password: 'adminpass1',
  });
  const users = await admin('GET', '/api/admin/users');
  const carolUser = users.data.users.find((u) => u.phone === '+14155550133');
  await admin('POST', `/api/admin/users/${carolUser.id}/decision`, {
    decision: 'approve',
  });

  // Bob shares his Groceries list with Carol.
  const bobClient = makeClient();
  await bobClient('POST', '/api/auth/login', {
    phone: '+14155550111',
    password: 'bobpass12',
  });
  const bobLists = await bobClient('GET', '/api/lists');
  const listId = bobLists.data.lists[0].id;
  const shared = await bobClient('POST', `/api/lists/${listId}/share`, {
    phone: '+14155550133',
  });
  assert.equal(shared.status, 200);
  assert.equal(shared.data.list.collaborators.length, 1);

  // Carol can now see and edit the shared list.
  const carolClient = makeClient();
  await carolClient('POST', '/api/auth/login', {
    phone: '+14155550133',
    password: 'carolpass1',
  });
  const carolLists = await carolClient('GET', '/api/lists');
  assert.equal(carolLists.data.lists.length, 1);
  assert.equal(carolLists.data.lists[0].isOwner, false);

  const addItem = await carolClient('POST', `/api/lists/${listId}/items`, {
    text: 'Bread',
  });
  assert.equal(addItem.status, 201);
  assert.equal(addItem.data.list.items.length, 3);

  // Carol (a collaborator) cannot delete the list.
  const del = await carolClient('DELETE', `/api/lists/${listId}`);
  assert.equal(del.status, 403);
});
