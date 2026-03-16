const SERVER_URL = window.location.origin;
const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/ws';
const VAPID_PUBLIC_KEY = 'YOUR_VAPID_PUBLIC_KEY';
const COLORS = ['#6c63ff','#e05c97','#f59e0b','#10b981','#3b82f6','#ef4444','#8b5cf6','#06b6d4'];

const store = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

let state = {
  userId: null, username: null, displayName: null, avatarColor: '#6c63ff',
  contacts: {}, messages: {}, activeContact: null, ws: null, wsReady: false,
  typingTimers: {}, pendingRegData: null,
};

// --- Init ---
window.addEventListener('DOMContentLoaded', () => {
  const saved = store.get('user');
  if (saved?.id) {
    Object.assign(state, saved);
    state.contacts = store.get('contacts') || {};
    state.messages = store.get('messages') || {};
    showMain();
    connectWs();
  } else {
    showAuth();
  }
  bindEvents();
});

// --- Screens ---
function showAuth() {
  document.getElementById('screen-auth').classList.remove('hidden');
  document.getElementById('screen-main').classList.add('hidden');
  document.getElementById('screen-username').classList.add('hidden');
}

function showUsernameSetup() {
  document.getElementById('screen-auth').classList.add('hidden');
  document.getElementById('screen-username').classList.remove('hidden');
  document.getElementById('setup-username').focus();
}

function showMain() {
  document.getElementById('screen-auth').classList.add('hidden');
  document.getElementById('screen-username').classList.add('hidden');
  document.getElementById('screen-main').classList.remove('hidden');
  renderMe();
  renderContacts();
}

function renderMe() {
  document.getElementById('my-display-name').textContent = state.displayName || state.username;
  document.getElementById('my-id').textContent = state.userId;
  const av = document.getElementById('me-avatar');
  av.style.background = state.avatarColor;
  av.textContent = (state.displayName || state.username || '?')[0].toUpperCase();
}

// --- Auth ---
async function doLogin() {
  const username = document.getElementById('login-username').value.trim().replace(/^@/, '').toLowerCase();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('auth-error');
  errEl.textContent = '';
  if (!username || !password) return;
  try {
    const res = await fetch(`${SERVER_URL}/login`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Ошибка'; return; }
    saveUser(data);
    showMain();
    connectWs();
  } catch { errEl.textContent = 'Нет соединения с сервером'; }
}

async function doRegisterStep1() {
  const displayName = document.getElementById('reg-display-name').value.trim();
  const password = document.getElementById('reg-password').value;
  const errEl = document.getElementById('auth-error');
  errEl.textContent = '';
  if (!displayName || password.length < 4) {
    errEl.textContent = 'Заполните все поля (пароль мин. 4 символа)'; return;
  }
  state.pendingRegData = { displayName, password };
  showUsernameSetup();
}

async function doRegisterStep2() {
  const username = document.getElementById('setup-username').value.trim().toLowerCase();
  const errEl = document.getElementById('username-error');
  errEl.textContent = '';
  if (!username || !/^[a-z0-9_]{3,32}$/.test(username)) {
    errEl.textContent = 'Только латиница, цифры и _ (3-32 символа)'; return;
  }
  const { displayName, password } = state.pendingRegData;
  try {
    const res = await fetch(`${SERVER_URL}/register`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error === 'Username taken' ? 'Username занят' : (data.error || 'Ошибка'); return; }
    // Сохранить display_name через profile update
    await fetch(`${SERVER_URL}/profile`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ id: data.id, display_name: displayName, bio: '', avatar_color: '#6c63ff' }),
    });
    saveUser({ ...data, display_name: displayName, avatar_color: '#6c63ff' });
    showMain();
    connectWs();
  } catch { errEl.textContent = 'Нет соединения с сервером'; }
}

function saveUser(data) {
  state.userId = data.id;
  state.username = data.username;
  state.displayName = data.display_name || data.username;
  state.avatarColor = data.avatar_color || '#6c63ff';
  store.set('user', { userId: state.userId, username: state.username, displayName: state.displayName, avatarColor: state.avatarColor });
}

// --- Username availability check ---
let usernameCheckTimer = null;
function onUsernameInput() {
  const val = document.getElementById('setup-username').value.trim().toLowerCase();
  const checkEl = document.getElementById('username-check');
  const btn = document.getElementById('btn-confirm-username');
  btn.disabled = true;
  checkEl.className = 'username-check';
  checkEl.textContent = '';
  if (!val) return;
  if (!/^[a-z0-9_]{3,32}$/.test(val)) {
    checkEl.textContent = 'Только латиница, цифры и _';
    checkEl.className = 'username-check taken';
    return;
  }
  checkEl.textContent = 'Проверяем...';
  clearTimeout(usernameCheckTimer);
  usernameCheckTimer = setTimeout(async () => {
    try {
      const res = await fetch(`${SERVER_URL}/username/${val}`);
      if (res.ok) {
        checkEl.textContent = '@' + val + ' уже занят';
        checkEl.className = 'username-check taken';
      } else {
        checkEl.textContent = '@' + val + ' свободен ✓';
        checkEl.className = 'username-check ok';
        btn.disabled = false;
      }
    } catch {
      checkEl.textContent = '';
      btn.disabled = false;
    }
  }, 500);
}

// --- WebSocket ---
function connectWs() {
  if (state.ws) { try { state.ws.close(); } catch {} }
  const ws = new WebSocket(WS_URL);
  state.ws = ws;
  state.wsReady = false;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', user_id: state.userId }));
  ws.onmessage = (e) => handleWsMessage(JSON.parse(e.data));
  ws.onclose = () => { state.wsReady = false; setTimeout(connectWs, 3000); };
  ws.onerror = () => ws.close();
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'authed':
      state.wsReady = true;
      setupPush();
      break;
    case 'incoming': {
      const { id, from, from_name, from_color, text, timestamp } = msg;
      if (!state.contacts[from]) {
        state.contacts[from] = { id: from, username: '', displayName: from_name, avatarColor: from_color || '#6c63ff', online: true };
        saveContacts(); renderContacts();
      }
      pushMessage(from, { id, from, text, timestamp, out: false, status: 'delivered' });
      // Отправить read если чат открыт
      if (state.activeContact === from && state.wsReady) {
        state.ws.send(JSON.stringify({ type: 'mark_read', from }));
      } else {
        notifyContact(from, from_name, text);
      }
      break;
    }
    case 'delivered': {
      updateMsgStatus(msg.id, 'delivered');
      break;
    }
    case 'read': {
      msg.msg_ids.forEach(id => updateMsgStatus(id, 'read'));
      break;
    }
    case 'typing_indicator': {
      showTyping(msg.from, msg.from_name);
      break;
    }
    case 'presence': {
      const { user_id, online, last_seen } = msg;
      if (state.contacts[user_id]) {
        state.contacts[user_id].online = online;
        state.contacts[user_id].lastSeen = last_seen;
        saveContacts(); renderContacts();
        if (state.activeContact === user_id) updateChatStatus(user_id);
      }
      break;
    }
  }
}

function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text || !state.activeContact || !state.wsReady) return;
  state.ws.send(JSON.stringify({ type: 'send', to: state.activeContact, text }));
  const timestamp = Math.floor(Date.now() / 1000);
  const tempId = Date.now();
  pushMessage(state.activeContact, { id: tempId, from: state.userId, text, timestamp, out: true, status: 'sent' });
  input.value = '';
}

let typingTimer = null;
function onMsgInput() {
  if (!state.activeContact || !state.wsReady) return;
  state.ws.send(JSON.stringify({ type: 'typing', to: state.activeContact }));
  clearTimeout(typingTimer);
}

// --- Contacts ---
async function addContact() {
  const errEl = document.getElementById('add-error');
  errEl.textContent = '';
  const activeStab = document.querySelector('.stab.active').dataset.stab;
  let user = null;

  if (activeStab === 'username') {
    const username = document.getElementById('search-username-input').value.trim().replace(/^@/, '').toLowerCase();
    if (!username) { errEl.textContent = 'Введите username'; return; }
    try {
      const res = await fetch(`${SERVER_URL}/username/${username}`);
      if (!res.ok) throw new Error();
      user = await res.json();
    } catch { errEl.textContent = 'Пользователь не найден'; return; }
  } else {
    const id = document.getElementById('input-contact-id').value.trim().toLowerCase();
    if (!id || id.length !== 8) { errEl.textContent = 'ID должен быть 8 символов'; return; }
    try {
      const res = await fetch(`${SERVER_URL}/user/${id}`);
      if (!res.ok) throw new Error();
      user = await res.json();
    } catch { errEl.textContent = 'Пользователь не найден'; return; }
  }

  if (user.id === state.userId) { errEl.textContent = 'Нельзя добавить себя'; return; }
  state.contacts[user.id] = {
    id: user.id, username: user.username,
    displayName: user.display_name || user.username,
    avatarColor: user.avatar_color || '#6c63ff',
    online: false, lastSeen: user.last_seen || 0,
  };
  saveContacts(); renderContacts(); closeModal();
}

async function searchUserPreview() {
  const activeStab = document.querySelector('.stab.active').dataset.stab;
  const preview = document.getElementById('found-user-preview');
  preview.classList.add('hidden');
  preview.innerHTML = '';

  let username = '';
  if (activeStab === 'username') {
    username = document.getElementById('search-username-input').value.trim().replace(/^@/, '').toLowerCase();
    if (username.length < 2) return;
  } else return;

  try {
    const res = await fetch(`${SERVER_URL}/username/${username}`);
    if (!res.ok) return;
    const u = await res.json();
    preview.innerHTML = `
      <div class="avatar" style="background:${u.avatar_color||'#6c63ff'}">${(u.display_name||u.username)[0].toUpperCase()}</div>
      <div class="found-user-info">
        <span class="found-user-name">${escHtml(u.display_name||u.username)}</span>
        <span class="found-user-username">@${escHtml(u.username)}</span>
      </div>`;
    preview.classList.remove('hidden');
  } catch {}
}

function saveContacts() { store.set('contacts', state.contacts); }

function renderContacts() {
  const list = document.getElementById('contacts-list');
  list.innerHTML = '';
  const contacts = Object.values(state.contacts);
  if (!contacts.length) {
    list.innerHTML = '<p style="padding:16px;color:var(--text3);font-size:.82rem;text-align:center">Нет контактов.<br>Нажмите + чтобы добавить.</p>';
    return;
  }
  contacts.forEach(c => {
    const msgs = state.messages[c.id] || [];
    const last = msgs[msgs.length - 1];
    const el = document.createElement('div');
    el.className = 'contact-item' + (state.activeContact === c.id ? ' active' : '');
    el.innerHTML = `
      <div class="avatar" style="background:${c.avatarColor||'#6c63ff'}">
        ${(c.displayName||c.username||'?')[0].toUpperCase()}
        <span class="status-dot ${c.online ? 'online' : ''}"></span>
      </div>
      <div class="contact-info">
        <div class="contact-name">${escHtml(c.displayName||c.username)}</div>
        <div class="contact-sub">${last ? escHtml(last.text.slice(0,35)) : ('@' + (c.username||''))}</div>
      </div>
      <div class="contact-meta">
        ${last ? `<span class="contact-time">${fmtTime(last.timestamp)}</span>` : ''}
      </div>`;
    el.addEventListener('click', () => openChat(c.id));
    list.appendChild(el);
  });
}

function openChat(contactId) {
  state.activeContact = contactId;
  const c = state.contacts[contactId];
  document.getElementById('chat-title').textContent = c.displayName || c.username;
  updateChatStatus(contactId);
  const pav = document.getElementById('chat-peer-avatar');
  pav.style.background = c.avatarColor || '#6c63ff';
  pav.textContent = (c.displayName || c.username || '?')[0].toUpperCase();
  document.getElementById('msg-input').disabled = false;
  document.getElementById('btn-send').disabled = false;
  renderMessages(contactId);
  renderContacts();
  loadHistory(contactId);
  // Отметить прочитанным
  if (state.wsReady) state.ws.send(JSON.stringify({ type: 'mark_read', from: contactId }));
  if (window.innerWidth <= 640) document.getElementById('sidebar').classList.add('slide-out');
}

function updateChatStatus(contactId) {
  const c = state.contacts[contactId];
  if (!c) return;
  const el = document.getElementById('chat-status');
  if (c.online) {
    el.textContent = 'в сети';
    el.className = 'chat-status online';
  } else if (c.lastSeen) {
    el.textContent = 'был(а) ' + fmtLastSeen(c.lastSeen);
    el.className = 'chat-status';
  } else {
    el.textContent = '';
    el.className = 'chat-status';
  }
}

// --- Messages ---
function pushMessage(contactId, msg) {
  if (!state.messages[contactId]) state.messages[contactId] = [];
  if (msg.id && state.messages[contactId].some(m => m.id === msg.id)) return;
  state.messages[contactId].push(msg);
  store.set('messages', state.messages);
  if (state.activeContact === contactId) renderMessages(contactId);
  renderContacts();
}

function updateMsgStatus(msgId, status) {
  for (const cid of Object.keys(state.messages)) {
    const msg = state.messages[cid].find(m => m.id === msgId);
    if (msg) {
      msg.status = status;
      store.set('messages', state.messages);
      if (state.activeContact === cid) renderMessages(cid);
      break;
    }
  }
}

function renderMessages(contactId) {
  const container = document.getElementById('messages');
  const msgs = state.messages[contactId] || [];
  container.innerHTML = '';

  if (!msgs.length) {
    container.innerHTML = '<div class="empty-chat"><div class="icon">💬</div><span>Начните общение</span></div>';
    return;
  }

  let lastDate = null;
  msgs.forEach(msg => {
    const d = new Date(msg.timestamp * 1000);
    const dateStr = d.toLocaleDateString('ru', { day: 'numeric', month: 'long' });
    if (dateStr !== lastDate) {
      const div = document.createElement('div');
      div.className = 'date-divider';
      div.textContent = dateStr;
      container.appendChild(div);
      lastDate = dateStr;
    }
    const row = document.createElement('div');
    row.className = 'msg-row ' + (msg.out ? 'out' : 'in');
    row.dataset.id = msg.id;
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let statusIcon = '';
    if (msg.out) {
      if (msg.status === 'read') statusIcon = '<span class="msg-status read">✓✓</span>';
      else if (msg.status === 'delivered') statusIcon = '<span class="msg-status delivered">✓✓</span>';
      else statusIcon = '<span class="msg-status">✓</span>';
    }
    row.innerHTML = `
      <div class="msg-bubble">${escHtml(msg.text)}</div>
      <div class="msg-meta">
        <span class="msg-time">${time}</span>
        ${statusIcon}
      </div>`;
    container.appendChild(row);
  });
  container.scrollTop = container.scrollHeight;
}

async function loadHistory(contactId) {
  try {
    const res = await fetch(`${SERVER_URL}/history/${state.userId}?with=${contactId}`);
    if (!res.ok) return;
    const msgs = await res.json();
    const existing = new Set((state.messages[contactId] || []).map(m => m.id).filter(Boolean));
    const newMsgs = msgs.filter(m => !existing.has(m.id)).map(m => ({
      id: m.id, from: m.from_id, text: m.text, timestamp: m.timestamp,
      out: m.from_id === state.userId,
      status: m.read_at > 0 ? 'read' : (m.delivered ? 'delivered' : 'sent'),
    }));
    if (newMsgs.length) {
      state.messages[contactId] = [...newMsgs, ...(state.messages[contactId] || [])].sort((a, b) => a.timestamp - b.timestamp);
      store.set('messages', state.messages);
      if (state.activeContact === contactId) renderMessages(contactId);
    }
  } catch {}
}

// --- Typing ---
function showTyping(fromId, fromName) {
  if (state.activeContact !== fromId) return;
  let el = document.getElementById('typing-el');
  if (!el) {
    el = document.createElement('div');
    el.id = 'typing-el';
    el.className = 'typing-indicator';
    el.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div><span>${escHtml(fromName)} печатает...</span>`;
    document.getElementById('messages').appendChild(el);
  }
  clearTimeout(state.typingTimers[fromId]);
  state.typingTimers[fromId] = setTimeout(() => { el?.remove(); }, 3000);
  document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
}

// --- Profile ---
function openProfile() {
  document.getElementById('profile-display-name').value = state.displayName || '';
  document.getElementById('profile-bio').value = store.get('user')?.bio || '';
  renderColorSwatches();
  document.getElementById('modal-profile').classList.remove('hidden');
}

function renderColorSwatches() {
  const wrap = document.getElementById('color-swatches');
  wrap.innerHTML = '';
  const preview = document.getElementById('profile-avatar-preview');
  preview.style.background = state.avatarColor;
  preview.textContent = (state.displayName || state.username || '?')[0].toUpperCase();
  COLORS.forEach(c => {
    const s = document.createElement('div');
    s.className = 'swatch' + (c === state.avatarColor ? ' selected' : '');
    s.style.background = c;
    s.addEventListener('click', () => {
      state.avatarColor = c;
      preview.style.background = c;
      wrap.querySelectorAll('.swatch').forEach(x => x.classList.remove('selected'));
      s.classList.add('selected');
    });
    wrap.appendChild(s);
  });
}

async function saveProfile() {
  const displayName = document.getElementById('profile-display-name').value.trim();
  const bio = document.getElementById('profile-bio').value.trim();
  if (!displayName) return;
  await fetch(`${SERVER_URL}/profile`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ id: state.userId, display_name: displayName, bio, avatar_color: state.avatarColor }),
  });
  state.displayName = displayName;
  const saved = store.get('user') || {};
  store.set('user', { ...saved, displayName, avatarColor: state.avatarColor, bio });
  renderMe();
  document.getElementById('modal-profile').classList.add('hidden');
}

// --- Push ---
async function setupPush() {
  if (!('serviceWorker' in navigator) || VAPID_PUBLIC_KEY === 'YOUR_VAPID_PUBLIC_KEY') return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    if (await Notification.requestPermission() !== 'granted') return;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) });
    const { endpoint, keys } = sub.toJSON();
    await fetch(`${SERVER_URL}/push/subscribe`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ user_id: state.userId, endpoint, p256dh: keys.p256dh, auth: keys.auth }),
    });
  } catch {}
}

function urlBase64ToUint8Array(b) {
  const pad = '='.repeat((4 - b.length % 4) % 4);
  const base64 = (b + pad).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from([...atob(base64)].map(c => c.charCodeAt(0)));
}

// --- Modal ---
function openModal() {
  document.getElementById('modal-add').classList.remove('hidden');
  document.getElementById('search-username-input').value = '';
  document.getElementById('input-contact-id').value = '';
  document.getElementById('add-error').textContent = '';
  document.getElementById('found-user-preview').classList.add('hidden');
  document.getElementById('search-username-input').focus();
}
function closeModal() { document.getElementById('modal-add').classList.add('hidden'); }

// --- Events ---
function bindEvents() {
  // Auth tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-login').classList.add('hidden');
      document.getElementById('tab-register').classList.add('hidden');
      document.getElementById('tab-' + btn.dataset.tab).classList.remove('hidden');
      document.getElementById('auth-error').textContent = '';
    });
  });

  document.getElementById('btn-login').addEventListener('click', doLogin);
  document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('btn-register').addEventListener('click', doRegisterStep1);
  document.getElementById('reg-password').addEventListener('keydown', e => { if (e.key === 'Enter') doRegisterStep1(); });

  // Username setup
  document.getElementById('setup-username').addEventListener('input', onUsernameInput);
  document.getElementById('setup-username').addEventListener('keydown', e => { if (e.key === 'Enter' && !document.getElementById('btn-confirm-username').disabled) doRegisterStep2(); });
  document.getElementById('btn-confirm-username').addEventListener('click', doRegisterStep2);

  // Main
  document.getElementById('btn-add').addEventListener('click', openModal);
  document.getElementById('btn-profile').addEventListener('click', openProfile);
  document.getElementById('my-id').addEventListener('click', () => {
    navigator.clipboard.writeText(state.userId).then(() => {
      const el = document.getElementById('my-id');
      const orig = el.textContent;
      el.textContent = 'скопировано!';
      setTimeout(() => { el.textContent = orig; }, 1500);
    });
  });

  // Add contact modal
  document.getElementById('btn-confirm-add').addEventListener('click', addContact);
  document.getElementById('btn-cancel-add').addEventListener('click', closeModal);
  document.querySelectorAll('.stab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.stab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('stab-username').classList.toggle('hidden', btn.dataset.stab !== 'username');
      document.getElementById('stab-id').classList.toggle('hidden', btn.dataset.stab !== 'id');
      document.getElementById('found-user-preview').classList.add('hidden');
    });
  });
  document.getElementById('search-username-input').addEventListener('input', searchUserPreview);
  document.getElementById('search-username-input').addEventListener('keydown', e => { if (e.key === 'Enter') addContact(); });
  document.getElementById('input-contact-id').addEventListener('keydown', e => { if (e.key === 'Enter') addContact(); });

  // Chat
  document.getElementById('btn-send').addEventListener('click', sendMessage);
  document.getElementById('msg-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });
  document.getElementById('msg-input').addEventListener('input', onMsgInput);
  document.getElementById('btn-back').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('slide-out');
  });

  // Profile modal
  document.getElementById('btn-save-profile').addEventListener('click', saveProfile);
  document.getElementById('btn-close-profile').addEventListener('click', () => {
    document.getElementById('modal-profile').classList.add('hidden');
  });
}

// --- Utils ---
function notifyContact(contactId, name, text) {
  const orig = document.title;
  document.title = `(1) ${name}: ${text.slice(0, 30)}`;
  setTimeout(() => { document.title = orig; }, 4000);
}

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'short' });
}

function fmtLastSeen(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60) return 'только что';
  if (diff < 3600) return Math.floor(diff / 60) + ' мин. назад';
  if (d.toDateString() === now.toDateString()) return 'сегодня в ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'short' }) + ' в ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
