'use strict';

/**
 * Keepish frontend — a small, dependency-free single page app.
 *
 * All DOM content derived from user/server data is inserted via textContent or
 * created elements (never innerHTML), keeping the UI safe from XSS.
 */

const COLORS = [
  'default',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'gray',
];

const COLOR_VALUES = {
  default: '#ffffff',
  red: '#ffd8d2',
  orange: '#ffdfbf',
  yellow: '#fff4ba',
  green: '#dff0d1',
  teal: '#cce7e0',
  blue: '#d9e8f2',
  purple: '#e3dcf0',
  pink: '#f6dce2',
  gray: '#ecebea',
};

const state = {
  user: null,
  lists: [],
  search: '',
  composerColor: 'default',
  composerItems: [],
};

// ---- API helper ----------------------------------------------------------

function readCookie(name) {
  const match = document.cookie.match(
    new RegExp('(?:^|; )' + name + '=([^;]*)')
  );
  return match ? decodeURIComponent(match[1]) : null;
}

async function api(method, path, body) {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  // Include the CSRF token for state-changing requests (double-submit pattern).
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
    const token = readCookie('csrf_token');
    if (token) headers['X-CSRF-Token'] = token;
  }
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'Request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---- Small DOM helpers ---------------------------------------------------

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  }
  if (opts.on) {
    for (const [evt, fn] of Object.entries(opts.on)) node.addEventListener(evt, fn);
  }
  for (const child of children) {
    if (child) node.appendChild(child);
  }
  return node;
}

function $(sel) {
  return document.querySelector(sel);
}

let toastTimer = null;
function toast(message) {
  const t = $('#toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, 3000);
}

function initials(user) {
  const base = (user.displayName || user.phone || '?').trim();
  return base.charAt(0).toUpperCase();
}

// ---- Auth screen ---------------------------------------------------------

function showAuthMessage(text, kind) {
  const node = $('#auth-message');
  node.textContent = text || '';
  node.className = 'auth-message' + (kind ? ' is-' + kind : '');
}

function setupAuthScreen() {
  const tabs = document.querySelectorAll('.auth-tab');
  const loginForm = $('#login-form');
  const registerForm = $('#register-form');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      const isLogin = tab.dataset.tab === 'login';
      loginForm.hidden = !isLogin;
      registerForm.hidden = isLogin;
      showAuthMessage('');
    });
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    showAuthMessage('');
    const fd = new FormData(loginForm);
    try {
      const data = await api('POST', '/api/auth/login', {
        phone: fd.get('phone'),
        password: fd.get('password'),
      });
      state.user = data.user;
      enterApp();
    } catch (err) {
      showAuthMessage(err.message, 'error');
    }
  });

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    showAuthMessage('');
    const fd = new FormData(registerForm);
    try {
      const data = await api('POST', '/api/auth/register', {
        displayName: fd.get('displayName'),
        phone: fd.get('phone'),
        password: fd.get('password'),
      });
      if (data.user.status === 'approved') {
        state.user = data.user;
        enterApp();
      } else {
        showAuthMessage(data.message, 'success');
        registerForm.reset();
      }
    } catch (err) {
      showAuthMessage(err.message, 'error');
    }
  });
}

// ---- Navigation ----------------------------------------------------------

function showAuth() {
  $('#app-shell').hidden = true;
  $('#auth-screen').hidden = false;
}

function enterApp() {
  $('#auth-screen').hidden = true;
  $('#app-shell').hidden = false;

  const chip = $('#user-chip');
  chip.textContent = initials(state.user);
  chip.title = (state.user.displayName || '') + ' ' + state.user.phone;

  $('#nav-admin').hidden = state.user.role !== 'admin';
  showListsView();
  loadLists();
}

function showListsView() {
  $('#lists-view').hidden = false;
  $('#admin-view').hidden = true;
  $('#nav-lists').classList.add('is-active');
  $('#nav-admin').classList.remove('is-active');
}

function showAdminView() {
  $('#lists-view').hidden = true;
  $('#admin-view').hidden = false;
  $('#nav-lists').classList.remove('is-active');
  $('#nav-admin').classList.add('is-active');
  loadUsers();
}

function setupNav() {
  $('#nav-lists').addEventListener('click', showListsView);
  $('#nav-admin').addEventListener('click', showAdminView);
  $('#logout-btn').addEventListener('click', async () => {
    try {
      await api('POST', '/api/auth/logout');
    } catch (_) {
      /* ignore */
    }
    state.user = null;
    state.lists = [];
    showAuth();
  });
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value.toLowerCase();
    renderLists();
  });
}

// ---- Composer ------------------------------------------------------------

function renderColorRow(container, selected, onPick) {
  container.textContent = '';
  for (const color of COLORS) {
    const dot = el('button', {
      class: 'color-dot' + (color === selected ? ' is-selected' : ''),
      attrs: { type: 'button', title: color, 'aria-label': color },
    });
    dot.style.background = COLOR_VALUES[color];
    dot.addEventListener('click', () => onPick(color));
    container.appendChild(dot);
  }
}

function renderComposerItems() {
  const ul = $('#composer-items');
  ul.textContent = '';
  state.composerItems.forEach((text, idx) => {
    const li = el('li', {}, [
      el('span', { text: '☐' }),
      el('span', { text }),
      el('button', {
        text: '✕',
        attrs: { type: 'button', 'aria-label': 'Remove item' },
        on: {
          click: () => {
            state.composerItems.splice(idx, 1);
            renderComposerItems();
          },
        },
      }),
    ]);
    ul.appendChild(li);
  });
}

function setupComposer() {
  const composer = $('#composer');
  const titleInput = $('#composer-title');
  const extra = $('#composer-extra');
  const itemInput = $('#composer-item-input');

  const expand = () => {
    extra.hidden = false;
  };
  titleInput.addEventListener('focus', expand);

  const pickComposerColor = (color) => {
    state.composerColor = color;
    renderColorRow($('#composer-colors'), color, pickComposerColor);
    composer.style.background = COLOR_VALUES[color];
  };
  renderColorRow($('#composer-colors'), state.composerColor, pickComposerColor);

  itemInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const text = itemInput.value.trim();
      if (text) {
        state.composerItems.push(text);
        renderComposerItems();
        itemInput.value = '';
      }
    }
  });

  composer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pendingItem = itemInput.value.trim();
    if (pendingItem) {
      state.composerItems.push(pendingItem);
    }
    const title = titleInput.value.trim();
    if (!title && state.composerItems.length === 0) {
      collapseComposer();
      return;
    }
    try {
      await api('POST', '/api/lists', {
        title,
        color: state.composerColor,
        items: state.composerItems.map((text) => ({ text })),
      });
      collapseComposer();
      await loadLists();
    } catch (err) {
      toast(err.message);
    }
  });

  function collapseComposer() {
    titleInput.value = '';
    itemInput.value = '';
    state.composerItems = [];
    state.composerColor = 'default';
    composer.style.background = '';
    renderComposerItems();
    extra.hidden = true;
  }
}

// ---- Lists rendering -----------------------------------------------------

async function loadLists() {
  try {
    const data = await api('GET', '/api/lists');
    state.lists = data.lists;
    renderLists();
  } catch (err) {
    if (err.status === 401) {
      showAuth();
    } else {
      toast(err.message);
    }
  }
}

function listMatchesSearch(list) {
  if (!state.search) return true;
  const haystack = [
    list.title,
    ...list.items.map((i) => i.text),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(state.search);
}

function renderLists() {
  const grid = $('#lists-grid');
  grid.textContent = '';

  const visible = state.lists
    .filter((l) => !l.archived)
    .filter(listMatchesSearch);

  $('#lists-empty').hidden = visible.length !== 0;

  for (const list of visible) {
    grid.appendChild(renderNote(list));
  }
}

function renderNote(list) {
  const note = el('article', { class: 'note' });
  note.style.background = COLOR_VALUES[list.color] || COLOR_VALUES.default;

  // Title (editable for owner & collaborators)
  const title = el('div', {
    class: 'note-title',
    text: list.title || '',
    attrs: {
      contenteditable: 'true',
      role: 'textbox',
      'aria-label': 'List title',
    },
  });
  title.addEventListener('blur', async () => {
    const newTitle = title.textContent.trim();
    if (newTitle !== (list.title || '')) {
      await updateList(list.id, { title: newTitle });
    }
  });
  note.appendChild(title);

  // Items
  const ul = el('ul', { class: 'note-items' });
  for (const item of list.items) {
    ul.appendChild(renderItem(list, item));
  }
  note.appendChild(ul);

  // Add-item row
  const addInput = el('input', {
    attrs: { type: 'text', placeholder: 'List item', 'aria-label': 'Add item' },
  });
  addInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const text = addInput.value.trim();
      if (text) {
        addInput.value = '';
        await addItem(list.id, text);
      }
    }
  });
  note.appendChild(el('div', { class: 'note-add' }, [el('span', { text: '+' }), addInput]));

  // Collaborators
  if (list.collaborators.length) {
    const row = el('div', { class: 'shared-row' });
    for (const c of list.collaborators) {
      const chip = el('span', { class: 'chip' }, [
        el('span', { text: c.displayName || c.phone }),
      ]);
      if (list.isOwner) {
        chip.appendChild(
          el('button', {
            text: '✕',
            attrs: { type: 'button', 'aria-label': 'Remove collaborator' },
            on: { click: () => unshare(list.id, c.id) },
          })
        );
      }
      row.appendChild(chip);
    }
    note.appendChild(row);
  }

  if (!list.isOwner && list.owner) {
    note.appendChild(
      el('div', {
        class: 'note-meta',
        text: 'Shared by ' + (list.owner.displayName || list.owner.phone),
      })
    );
  }

  // Toolbar
  const toolbar = el('div', { class: 'note-toolbar' });
  toolbar.appendChild(buildColorButton(list));
  if (list.isOwner) {
    toolbar.appendChild(
      el('button', {
        text: '👤',
        attrs: { type: 'button', title: 'Share', 'aria-label': 'Share list' },
        on: { click: () => promptShare(list) },
      })
    );
    toolbar.appendChild(
      el('button', {
        text: '🗑',
        attrs: { type: 'button', title: 'Delete', 'aria-label': 'Delete list' },
        on: { click: () => deleteList(list) },
      })
    );
  } else {
    toolbar.appendChild(
      el('button', {
        text: '🚪',
        attrs: {
          type: 'button',
          title: 'Leave list',
          'aria-label': 'Leave list',
        },
        on: { click: () => unshare(list.id, state.user.id) },
      })
    );
  }
  note.appendChild(toolbar);

  return note;
}

function renderItem(list, item) {
  const li = el('li', { class: 'note-item' + (item.checked ? ' is-checked' : '') });

  const cb = el('input', { attrs: { type: 'checkbox' } });
  cb.checked = item.checked;
  cb.addEventListener('change', () =>
    updateItem(list.id, item.id, { checked: cb.checked })
  );

  const text = el('span', {
    class: 'item-text',
    text: item.text,
    attrs: { contenteditable: 'true', 'aria-label': 'Item text' },
  });
  text.addEventListener('blur', () => {
    const newText = text.textContent.trim();
    if (newText && newText !== item.text) {
      updateItem(list.id, item.id, { text: newText });
    } else if (!newText) {
      text.textContent = item.text;
    }
  });

  const del = el('button', {
    class: 'item-del',
    text: '✕',
    attrs: { type: 'button', 'aria-label': 'Delete item' },
    on: { click: () => deleteItem(list.id, item.id) },
  });

  li.appendChild(cb);
  li.appendChild(text);
  li.appendChild(del);
  return li;
}

function buildColorButton(list) {
  const wrap = el('span', { class: 'color-pop-wrap' });
  const btn = el('button', {
    text: '🎨',
    attrs: { type: 'button', title: 'Change colour', 'aria-label': 'Change colour' },
  });
  const palette = el('div', { class: 'color-row color-pop' });
  renderColorRow(palette, list.color, async (color) => {
    palette.classList.remove('is-open');
    await updateList(list.id, { color });
  });
  btn.addEventListener('click', () => {
    palette.classList.toggle('is-open');
  });
  wrap.appendChild(btn);
  wrap.appendChild(palette);
  return wrap;
}

// ---- List/item mutations -------------------------------------------------

function replaceList(updated) {
  const idx = state.lists.findIndex((l) => l.id === updated.id);
  if (idx >= 0) state.lists[idx] = updated;
  else state.lists.unshift(updated);
  renderLists();
}

async function updateList(id, patch) {
  try {
    const data = await api('PATCH', '/api/lists/' + id, patch);
    replaceList(data.list);
  } catch (err) {
    toast(err.message);
  }
}

async function deleteList(list) {
  if (!confirm('Delete this list? This cannot be undone.')) return;
  try {
    await api('DELETE', '/api/lists/' + list.id);
    state.lists = state.lists.filter((l) => l.id !== list.id);
    renderLists();
  } catch (err) {
    toast(err.message);
  }
}

async function addItem(listId, text) {
  try {
    const data = await api('POST', '/api/lists/' + listId + '/items', { text });
    replaceList(data.list);
  } catch (err) {
    toast(err.message);
  }
}

async function updateItem(listId, itemId, patch) {
  try {
    const data = await api(
      'PATCH',
      '/api/lists/' + listId + '/items/' + itemId,
      patch
    );
    replaceList(data.list);
  } catch (err) {
    toast(err.message);
  }
}

async function deleteItem(listId, itemId) {
  try {
    const data = await api('DELETE', '/api/lists/' + listId + '/items/' + itemId);
    replaceList(data.list);
  } catch (err) {
    toast(err.message);
  }
}

async function promptShare(list) {
  const phone = prompt(
    "Enter the collaborator's phone number to share this list:"
  );
  if (!phone) return;
  try {
    const data = await api('POST', '/api/lists/' + list.id + '/share', {
      phone,
    });
    replaceList(data.list);
    toast('List shared.');
  } catch (err) {
    toast(err.message);
  }
}

async function unshare(listId, userId) {
  try {
    await api('DELETE', '/api/lists/' + listId + '/share/' + userId);
    if (userId === state.user.id) {
      state.lists = state.lists.filter((l) => l.id !== listId);
      renderLists();
    } else {
      await loadLists();
    }
  } catch (err) {
    toast(err.message);
  }
}

// ---- Admin ---------------------------------------------------------------

async function loadUsers() {
  try {
    const data = await api('GET', '/api/admin/users');
    renderUsers(data.users);
  } catch (err) {
    toast(err.message);
  }
}

function renderUsers(users) {
  const body = $('#users-body');
  body.textContent = '';
  for (const user of users) {
    const tr = el('tr');
    tr.appendChild(el('td', { text: user.displayName || '—' }));
    tr.appendChild(el('td', { text: user.phone }));
    tr.appendChild(el('td', { text: user.role }));

    const statusTd = el('td');
    statusTd.appendChild(
      el('span', {
        class: 'status-badge status-' + user.status,
        text: user.status,
      })
    );
    tr.appendChild(statusTd);

    const actionsTd = el('td');
    if (user.status !== 'approved') {
      actionsTd.appendChild(
        el('button', {
          class: 'btn-sm btn-approve',
          text: 'Approve',
          attrs: { type: 'button' },
          on: { click: () => decideUser(user.id, 'approve') },
        })
      );
    }
    if (user.status !== 'declined') {
      actionsTd.appendChild(
        el('button', {
          class: 'btn-sm btn-decline',
          text: 'Decline',
          attrs: { type: 'button' },
          on: { click: () => decideUser(user.id, 'decline') },
        })
      );
    }
    tr.appendChild(actionsTd);
    body.appendChild(tr);
  }
}

async function decideUser(id, decision) {
  try {
    await api('POST', '/api/admin/users/' + id + '/decision', { decision });
    await loadUsers();
    toast('User ' + decision + 'd.');
  } catch (err) {
    toast(err.message);
  }
}

// ---- Boot ----------------------------------------------------------------

async function boot() {
  setupAuthScreen();
  setupNav();
  setupComposer();

  try {
    const data = await api('GET', '/api/auth/me');
    state.user = data.user;
    if (state.user.status === 'approved') {
      enterApp();
    } else {
      showAuth();
      showAuthMessage(
        'Your account is awaiting administrator approval.',
        'success'
      );
    }
  } catch (_) {
    showAuth();
  }
}

boot();
