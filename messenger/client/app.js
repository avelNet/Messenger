const SERVER_URL = window.location.origin;
const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/ws';
const VAPID_PUBLIC_KEY = 'YOUR_VAPID_PUBLIC_KEY';
const COLORS = ['#6c63ff','#e05c97','#f59e0b','#10b981','#3b82f6','#ef4444','#8b5cf6','#06b6d4'];

const store = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

let state = {
  userId: null, username: null, displayName: null, avatarColor: '#6c63ff', avatar: '',
  contacts: {}, messages: {}, unread: {},
  activeContact: null, ws: null, wsReady: false,
  typingTimers: {}, pendingRegData: null,
};

// pending outgoing: text -> resolve when delivered
const _pendingOut = new Map(); // key: text+timestamp -> {to, text, timestamp}
let _sendLock = false;

window.addEventListener('DOMContentLoaded', () => {
  const saved = store.get('user');
  if (saved?.userId) {
    state.userId = saved.userId;
    state.username = saved.username;
    state.displayName = saved.displayName;
    state.avatarColor = saved.avatarColor || '#6c63ff';
    state.avatar = saved.avatar || '';
    state.contacts = store.get('contacts') || {};
    state.messages = store.get('messages') || {};
    state.unread = store.get('unread') || {};
    showMain();
    connectWs();
  } else {
    showAuth();
  }
  bindEvents();
  // Динамическое обновление "был(а) X мин назад"
  setInterval(refreshStatuses, 30000);
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
  setAvatarEl(document.getElementById('me-avatar'), state.displayName || state.username, state.avatarColor, state.avatar || '');
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
    saveUser(data); showMain(); connectWs();
  } catch { errEl.textContent = 'Нет соединения с сервером'; }
}

async function doRegisterStep1() {
  const displayName = document.getElementById('reg-display-name').value.trim();
  const password = document.getElementById('reg-password').value;
  const errEl = document.getElementById('auth-error');
  errEl.textContent = '';
  if (!displayName || password.length < 4) { errEl.textContent = 'Заполните все поля (пароль мин. 4 символа)'; return; }
  state.pendingRegData = { displayName, password };
  showUsernameSetup();
}

async function doRegisterStep2() {
  const username = document.getElementById('setup-username').value.trim().toLowerCase();
  const errEl = document.getElementById('username-error');
  errEl.textContent = '';
  if (!username || !/^[a-z0-9_]{3,32}$/.test(username)) { errEl.textContent = 'Только латиница, цифры и _ (3-32 символа)'; return; }
  const { displayName, password } = state.pendingRegData;
  try {
    const res = await fetch(`${SERVER_URL}/register`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error === 'Username taken' ? 'Username занят' : (data.error || 'Ошибка'); return; }
    await fetch(`${SERVER_URL}/profile`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ id: data.id, display_name: displayName, bio: '', avatar_color: '#6c63ff' }),
    });
    saveUser({ ...data, display_name: displayName, avatar_color: '#6c63ff' });
    showMain(); connectWs();
  } catch { errEl.textContent = 'Нет соединения с сервером'; }
}

function saveUser(data) {
  state.userId = data.id;
  state.username = data.username;
  state.displayName = data.display_name || data.username;
  state.avatarColor = data.avatar_color || '#6c63ff';
  state.avatar = data.avatar || '';
  store.set('user', { userId: state.userId, username: state.username, displayName: state.displayName, avatarColor: state.avatarColor, avatar: state.avatar });
}

let usernameCheckTimer = null;
function onUsernameInput() {
  const val = document.getElementById('setup-username').value.trim().toLowerCase();
  const checkEl = document.getElementById('username-check');
  const btn = document.getElementById('btn-confirm-username');
  btn.disabled = true; checkEl.className = 'username-check'; checkEl.textContent = '';
  if (!val) return;
  if (!/^[a-z0-9_]{3,32}$/.test(val)) { checkEl.textContent = 'Только латиница, цифры и _'; checkEl.className = 'username-check taken'; return; }
  checkEl.textContent = 'Проверяем...';
  clearTimeout(usernameCheckTimer);
  usernameCheckTimer = setTimeout(async () => {
    try {
      const res = await fetch(`${SERVER_URL}/username/${val}`);
      if (res.ok) { checkEl.textContent = '@' + val + ' уже занят'; checkEl.className = 'username-check taken'; }
      else { checkEl.textContent = '@' + val + ' свободен ✓'; checkEl.className = 'username-check ok'; btn.disabled = false; }
    } catch { checkEl.textContent = ''; btn.disabled = false; }
  }, 500);
}

// --- WebSocket ---
function connectWs() {
  if (state.ws) { try { state.ws.close(); } catch {} }
  const ws = new WebSocket(WS_URL);
  state.ws = ws; state.wsReady = false;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', user_id: state.userId }));
  ws.onmessage = (e) => handleWsMsg(JSON.parse(e.data));
  ws.onclose = () => { state.wsReady = false; setTimeout(connectWs, 3000); };
  ws.onerror = () => ws.close();
}

function handleWsMsg(msg) {
  switch (msg.type) {

    case 'authed':
      state.wsReady = true;
      setupPush();
      // Загрузить историю и свежие статусы для всех контактов
      Object.keys(state.contacts).forEach(cid => {
        loadHistory(cid);
        fetch(`${SERVER_URL}/user/${cid}`).then(r => r.json()).then(u => {
          if (!state.contacts[cid]) return;
          state.contacts[cid].lastSeen = u.last_seen || 0;
          saveContacts(); renderContacts();
          if (state.activeContact === cid) updateChatHeader(cid);
        }).catch(() => {});
      });
      break;

    case 'incoming': {
      const { id, from, from_name, from_color, text, timestamp } = msg;
      const doAdd = () => {
        addMsg(from, { id, from, text, timestamp, out: false, status: 'read_by_me' });
        if (state.activeContact === from && state.wsReady) {
          // Чат открыт — сразу mark_read
          state.ws.send(JSON.stringify({ type: 'mark_read', from }));
        } else {
          state.unread[from] = (state.unread[from] || 0) + 1;
          store.set('unread', state.unread);
          renderContacts();
          notifyTitle(from_name, text);
        }
      };
      if (!state.contacts[from]) {
        fetch(`${SERVER_URL}/user/${from}`).then(r => r.json()).then(u => {
          state.contacts[from] = { id: from, username: u.username || '', displayName: u.display_name || from_name, avatarColor: u.avatar_color || from_color || '#6c63ff', avatar: u.avatar || '', online: true, lastSeen: 0 };
          saveContacts(); renderContacts(); doAdd();
        }).catch(() => {
          state.contacts[from] = { id: from, username: '', displayName: from_name, avatarColor: from_color || '#6c63ff', avatar: '', online: true, lastSeen: 0 };
          saveContacts(); renderContacts(); doAdd();
        });
      } else { doAdd(); }
      break;
    }

    case 'delivered': {
      // FIFO: берём первый pending и добавляем с реальным id
      handleDelivered(msg.id);
      break;
    }

    case 'read':
      msg.msg_ids.forEach(id => updateMsgStatus(id, 'read'));
      break;

    case 'typing_indicator':
      showTyping(msg.from, msg.from_name);
      break;

    case 'force_logout':
      logout();
      break;

    case 'presence': {
      const { user_id, online, last_seen } = msg;
      if (state.contacts[user_id]) {
        state.contacts[user_id].online = online;
        if (!online && last_seen) state.contacts[user_id].lastSeen = last_seen;
        saveContacts(); renderContacts();
        if (state.activeContact === user_id) updateChatHeader(user_id);
      }
      break;
    }
  }
}

// --- Send ---
let _sendLockTimer = null;
function sendMessage() {
  if (_sendLock) return;
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text || !state.activeContact || !state.wsReady) return;
  _sendLock = true;
  clearTimeout(_sendLockTimer);
  _sendLockTimer = setTimeout(() => { _sendLock = false; }, 200);

  const to = state.activeContact;
  const timestamp = Math.floor(Date.now() / 1000);
  input.value = '';

  // Используем timestamp как временный ключ для pending
  // Сервер вернёт Delivered{id} — тогда добавим в UI с реальным id
  // Если собеседник оффлайн — Delivered не придёт, добавим через loadHistory
  const pendingKey = Date.now(); // уникальный ключ
  _pendingOut.set(pendingKey, { to, text, timestamp });

  state.ws.send(JSON.stringify({ type: 'send', to, text }));

  // Если через 5 сек Delivered не пришёл (оффлайн) — добавляем через loadHistory
  setTimeout(() => {
    if (_pendingOut.has(pendingKey)) {
      _pendingOut.delete(pendingKey);
      // Добавляем с временным отрицательным id, loadHistory заменит
      const tmpId = -(Date.now());
      addMsg(to, { id: tmpId, from: state.userId, text, timestamp, out: true, status: 'sent' });
      loadHistory(to);
    }
  }, 5000);
}

// Сервер шлёт Delivered{id: i64} — нужно сопоставить с pending по порядку FIFO
// Переопределяем обработку: берём первый pending для нужного to
function handleDelivered(realId) {
  // Ищем первый pending для любого to (FIFO — отправляем по одному)
  for (const [key, p] of _pendingOut) {
    _pendingOut.delete(key);
    addMsg(p.to, { id: realId, from: state.userId, text: p.text, timestamp: p.timestamp, out: true, status: 'delivered' });
    return;
  }
  // Если pending нет — просто обновляем статус
  updateMsgStatus(realId, 'delivered');
}

let typingTimer = null;
function onMsgInput() {
  if (!state.activeContact || !state.wsReady) return;
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    state.ws.send(JSON.stringify({ type: 'typing', to: state.activeContact }));
  }, 300);
}

// --- Contacts ---
async function addContact() {
  const errEl = document.getElementById('add-error');
  errEl.textContent = '';
  const username = document.getElementById('search-username-input').value.trim().replace(/^@/, '').toLowerCase();
  if (!username) { errEl.textContent = 'Введите username'; return; }
  try {
    const res = await fetch(`${SERVER_URL}/username/${username}`);
    if (!res.ok) throw new Error();
    const user = await res.json();
    if (user.id === state.userId) { errEl.textContent = 'Нельзя добавить себя'; return; }
    state.contacts[user.id] = { id: user.id, username: user.username, displayName: user.display_name || user.username, avatarColor: user.avatar_color || '#6c63ff', avatar: user.avatar || '', online: false, lastSeen: user.last_seen || 0 };
    saveContacts(); renderContacts(); closeModal();
  } catch { errEl.textContent = 'Пользователь не найден'; }
}

async function searchUserPreview() {
  const preview = document.getElementById('found-user-preview');
  preview.classList.add('hidden'); preview.innerHTML = '';
  const username = document.getElementById('search-username-input').value.trim().replace(/^@/, '').toLowerCase();
  if (username.length < 2) return;
  try {
    const res = await fetch(`${SERVER_URL}/username/${username}`);
    if (!res.ok) return;
    const u = await res.json();
    preview.innerHTML = `<div class="avatar" style="background:${u.avatar_color||'#6c63ff'}">${(u.display_name||u.username)[0].toUpperCase()}</div><div class="found-user-info"><span class="found-user-name">${escHtml(u.display_name||u.username)}</span><span class="found-user-username">@${escHtml(u.username)}</span></div>`;
    preview.classList.remove('hidden');
  } catch {}
}

function saveContacts() { store.set('contacts', state.contacts); }

function renderContacts() {
  const list = document.getElementById('contacts-list');
  list.innerHTML = '';
  const contacts = Object.values(state.contacts);
  if (!contacts.length) {
    list.innerHTML = '<p style="padding:16px;color:var(--text3);font-size:.82rem;text-align:center">Нет контактов.<br>Нажмите 🔍 чтобы добавить.</p>';
    return;
  }
  contacts.forEach(c => {
    const msgs = state.messages[c.id] || [];
    const last = msgs[msgs.length - 1];
    const unreadCount = state.unread[c.id] || 0;
    const el = document.createElement('div');
    el.className = 'contact-item' + (state.activeContact === c.id ? ' active' : '');
    el.innerHTML = `
      <div class="avatar" style="background:${c.avatarColor||'#6c63ff'}">
        ${c.avatar ? `<img src="${c.avatar}" alt=""/>` : (c.displayName||c.username||'?')[0].toUpperCase()}
        <span class="status-dot ${c.online ? 'online' : ''}"></span>
      </div>
      <div class="contact-info">
        <div class="contact-name">${escHtml(c.displayName||c.username)}</div>
        <div class="contact-sub">${last ? escHtml(last.text.slice(0,35)) : ('@'+(c.username||''))}</div>
      </div>
      <div class="contact-meta">
        ${last ? `<span class="contact-time">${fmtTime(last.timestamp)}</span>` : ''}
        ${unreadCount > 0 ? `<span class="unread-badge">${unreadCount}</span>` : ''}
      </div>`;
    el.addEventListener('click', () => openChat(c.id));
    list.appendChild(el);
  });
}

function openChat(contactId) {
  state.activeContact = contactId;
  if (state.unread[contactId]) { delete state.unread[contactId]; store.set('unread', state.unread); }
  const c = state.contacts[contactId];
  document.getElementById('msg-input').disabled = false;
  document.getElementById('btn-send').disabled = false;
  updateChatHeader(contactId);
  renderMessages(contactId);
  renderContacts();
  loadHistory(contactId);
  if (state.wsReady) state.ws.send(JSON.stringify({ type: 'mark_read', from: contactId }));
  if (window.innerWidth <= 640) document.getElementById('sidebar').classList.add('slide-out');
  document.getElementById('msg-input').focus();
}

function closeChat() {
  state.activeContact = null;
  document.getElementById('chat-title').textContent = 'Выберите контакт';
  document.getElementById('chat-status').textContent = '';
  document.getElementById('chat-status').className = 'chat-status';
  document.getElementById('chat-peer-avatar').textContent = '';
  document.getElementById('chat-peer-avatar').style.background = 'var(--bg3)';
  document.getElementById('messages').innerHTML = '';
  document.getElementById('msg-input').disabled = true;
  document.getElementById('btn-send').disabled = true;
  renderContacts();
  if (window.innerWidth <= 640) document.getElementById('sidebar').classList.remove('slide-out');
}

function updateChatHeader(contactId) {
  const c = state.contacts[contactId];
  if (!c) return;
  document.getElementById('chat-title').textContent = c.displayName || c.username;
  const pav = document.getElementById('chat-peer-avatar');
  pav.style.background = c.avatarColor || '#6c63ff';
  if (c.avatar) pav.innerHTML = `<img src="${c.avatar}" alt=""/>`;
  else pav.textContent = (c.displayName || c.username || '?')[0].toUpperCase();
  // Статус
  const el = document.getElementById('chat-status');
  if (c.online) { el.textContent = 'в сети'; el.className = 'chat-status online'; }
  else if (c.lastSeen) { el.textContent = 'был(а) ' + fmtLastSeen(c.lastSeen); el.className = 'chat-status'; }
  else { el.textContent = ''; el.className = 'chat-status'; }
}

// Периодически обновляем "был(а) X мин назад" без запроса к серверу
function refreshStatuses() {
  Object.values(state.contacts).forEach(c => {
    if (!c.online && c.lastSeen) {
      // Просто перерисовываем — fmtLastSeen пересчитает
    }
  });
  renderContacts();
  if (state.activeContact) updateChatHeader(state.activeContact);
}

// --- Messages ---
function addMsg(contactId, msg) {
  if (!state.messages[contactId]) state.messages[contactId] = [];
  // Дедупликация по реальному id (не отрицательным tmp)
  if (msg.id > 0 && state.messages[contactId].some(m => m.id === msg.id)) return;
  state.messages[contactId].push(msg);
  store.set('messages', state.messages);
  if (state.activeContact === contactId) renderMessages(contactId);
  renderContacts();
}

function updateMsgStatus(msgId, status) {
  for (const cid of Object.keys(state.messages)) {
    const m = state.messages[cid].find(x => x.id === msgId);
    if (m) {
      m.status = status;
      store.set('messages', state.messages);
      if (state.activeContact === cid) renderMessages(cid);
      return;
    }
  }
}

function renderMessages(contactId) {
  const container = document.getElementById('messages');
  const msgs = (state.messages[contactId] || []).filter(m => m.id > 0 || m.out);
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
      div.className = 'date-divider'; div.textContent = dateStr;
      container.appendChild(div); lastDate = dateStr;
    }
    const row = document.createElement('div');
    row.className = 'msg-row ' + (msg.out ? 'out' : 'in');
    row.dataset.id = msg.id;
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let statusIcon = '';
    if (msg.out) {
      if (msg.status === 'read') statusIcon = '<span class="msg-status read">✓✓</span>';
      else if (msg.status === 'delivered') statusIcon = '<span class="msg-status delivered">✓✓</span>';
      else statusIcon = '<span class="msg-status sent">✓</span>';
    }
    row.innerHTML = `<div class="msg-bubble">${escHtml(msg.text)}</div><div class="msg-meta"><span class="msg-time">${time}</span>${statusIcon}</div>`;
    container.appendChild(row);
  });
  container.scrollTop = container.scrollHeight;
}

async function loadHistory(contactId) {
  try {
    const res = await fetch(`${SERVER_URL}/history/${state.userId}?with=${contactId}`);
    if (!res.ok) return;
    const msgs = await res.json();
    // Строим map по реальным id
    const existing = new Map((state.messages[contactId] || []).filter(m => m.id > 0).map(m => [m.id, m]));
    let changed = false;
    msgs.forEach(m => {
      const status = m.read_at > 0 ? 'read' : (m.delivered > 0 ? 'delivered' : 'sent');
      if (existing.has(m.id)) {
        const local = existing.get(m.id);
        if (local.status !== status) { local.status = status; changed = true; }
      } else {
        existing.set(m.id, { id: m.id, from: m.from_id, text: m.text, timestamp: m.timestamp, out: m.from_id === state.userId, status });
        changed = true;
      }
    });
    if (changed) {
      state.messages[contactId] = Array.from(existing.values()).sort((a, b) => a.timestamp - b.timestamp);
      store.set('messages', state.messages);
      if (state.activeContact === contactId) renderMessages(contactId);
      renderContacts();
    }
  } catch {}
}

// --- Typing ---
function showTyping(fromId, fromName) {
  if (state.activeContact !== fromId) return;
  let el = document.getElementById('typing-el');
  if (!el) {
    el = document.createElement('div'); el.id = 'typing-el'; el.className = 'typing-indicator';
    el.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div><span>${escHtml(fromName)} печатает...</span>`;
    document.getElementById('messages').appendChild(el);
  }
  clearTimeout(state.typingTimers[fromId]);
  state.typingTimers[fromId] = setTimeout(() => { el?.remove(); }, 3000);
  document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
}

// --- Profile ---
function openProfile() {
  const saved = store.get('user') || {};
  document.getElementById('profile-display-name').value = state.displayName || '';
  document.getElementById('profile-username-show').value = state.username || '';
  document.getElementById('profile-bio').value = saved.bio || '';
  document.getElementById('profile-id-show').textContent = state.userId;
  document.getElementById('old-password').value = '';
  document.getElementById('new-password').value = '';
  document.getElementById('new-password2').value = '';
  document.getElementById('password-msg').textContent = '';
  renderColorSwatches();
  document.getElementById('modal-profile').classList.remove('hidden');
}

function renderColorSwatches() {
  const wrap = document.getElementById('color-swatches');
  wrap.innerHTML = '';
  const preview = document.getElementById('profile-avatar-preview');
  setAvatarEl(preview, state.displayName || state.username, state.avatarColor, state.avatar);
  COLORS.forEach(c => {
    const s = document.createElement('div');
    s.className = 'swatch' + (c === state.avatarColor ? ' selected' : '');
    s.style.background = c;
    s.addEventListener('click', () => {
      state.avatarColor = c;
      if (!state.avatar) preview.style.background = c;
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
  await fetch(`${SERVER_URL}/profile`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: state.userId, display_name: displayName, bio, avatar_color: state.avatarColor }) });
  state.displayName = displayName;
  const saved = store.get('user') || {};
  store.set('user', { ...saved, displayName, avatarColor: state.avatarColor, bio });
  renderMe();
  document.getElementById('modal-profile').classList.add('hidden');
}

async function changePassword() {
  const oldPw = document.getElementById('old-password').value;
  const newPw = document.getElementById('new-password').value;
  const newPw2 = document.getElementById('new-password2').value;
  const msgEl = document.getElementById('password-msg');
  msgEl.textContent = ''; msgEl.style.color = '#f87171';
  if (!oldPw || !newPw) { msgEl.textContent = 'Заполните все поля'; return; }
  if (newPw !== newPw2) { msgEl.textContent = 'Пароли не совпадают'; return; }
  if (newPw.length < 4) { msgEl.textContent = 'Пароль слишком короткий'; return; }
  try {
    const res = await fetch(`${SERVER_URL}/password`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: state.userId, old_password: oldPw, new_password: newPw }) });
    const data = await res.json();
    if (!res.ok) { msgEl.textContent = data.error || 'Ошибка'; return; }
    msgEl.style.color = 'var(--online)'; msgEl.textContent = 'Пароль изменён';
    document.getElementById('old-password').value = '';
    document.getElementById('new-password').value = '';
    document.getElementById('new-password2').value = '';
  } catch { msgEl.textContent = 'Ошибка соединения'; }
}

async function uploadAvatar(file) {
  const form = new FormData();
  form.append('user_id', state.userId); form.append('avatar', file);
  try {
    const res = await fetch(`${SERVER_URL}/avatar`, { method: 'POST', body: form });
    const data = await res.json();
    if (res.ok && data.avatar) {
      state.avatar = data.avatar;
      const saved = store.get('user') || {};
      store.set('user', { ...saved, avatar: data.avatar });
      renderMe(); renderColorSwatches();
    }
  } catch {}
}

async function openPeerProfile(contactId) {
  try {
    const res = await fetch(`${SERVER_URL}/user/${contactId}`);
    if (!res.ok) return;
    const u = await res.json();
    if (state.contacts[contactId]) {
      state.contacts[contactId].lastSeen = u.last_seen || 0;
      state.contacts[contactId].displayName = u.display_name || u.username;
      state.contacts[contactId].avatarColor = u.avatar_color || '#6c63ff';
      state.contacts[contactId].avatar = u.avatar || '';
      saveContacts();
      if (state.activeContact === contactId) updateChatHeader(contactId);
    }
    setAvatarEl(document.getElementById('peer-avatar'), u.display_name || u.username, u.avatar_color || '#6c63ff', u.avatar || '');
    document.getElementById('peer-display-name').textContent = u.display_name || u.username;
    document.getElementById('peer-username').textContent = '@' + u.username;
    document.getElementById('peer-bio').textContent = u.bio || '';
    const isOnline = state.contacts[contactId]?.online || false;
    const lsEl = document.getElementById('peer-lastseen');
    lsEl.textContent = isOnline ? 'в сети' : (u.last_seen ? 'был(а) ' + fmtLastSeen(u.last_seen) : '');
    lsEl.style.color = isOnline ? 'var(--online)' : '';
    document.getElementById('modal-peer-profile').classList.remove('hidden');
  } catch {}
}

function setAvatarEl(el, name, color, avatarData) {
  el.style.background = color || '#6c63ff';
  if (avatarData) el.innerHTML = `<img src="${avatarData}" alt="avatar"/>`;
  else el.textContent = (name || '?')[0].toUpperCase();
}

function logout() {
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  state.userId = null; state.username = null; state.displayName = null;
  state.avatarColor = '#6c63ff'; state.avatar = '';
  state.contacts = {}; state.messages = {}; state.unread = {}; state.activeContact = null; state.wsReady = false;
  localStorage.clear();
  showAuth();
}

async function setupPush() {
  if (!('serviceWorker' in navigator) || VAPID_PUBLIC_KEY === 'YOUR_VAPID_PUBLIC_KEY') return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    if (await Notification.requestPermission() !== 'granted') return;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) });
    const { endpoint, keys } = sub.toJSON();
    await fetch(`${SERVER_URL}/push/subscribe`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ user_id: state.userId, endpoint, p256dh: keys.p256dh, auth: keys.auth }) });
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
  document.getElementById('setup-username').addEventListener('input', onUsernameInput);
  document.getElementById('setup-username').addEventListener('keydown', e => { if (e.key === 'Enter' && !document.getElementById('btn-confirm-username').disabled) doRegisterStep2(); });
  document.getElementById('btn-confirm-username').addEventListener('click', doRegisterStep2);

  // Sidebar
  document.getElementById('btn-add').addEventListener('click', openModal);
  document.getElementById('btn-profile').addEventListener('click', openProfile);
  document.getElementById('my-id').addEventListener('click', () => {
    navigator.clipboard.writeText(state.userId).then(() => {
      const el = document.getElementById('my-id');
      const orig = el.textContent; el.textContent = 'скопировано!';
      setTimeout(() => { el.textContent = orig; }, 1500);
    });
  });

  // Add contact modal
  document.getElementById('btn-confirm-add').addEventListener('click', addContact);
  document.getElementById('btn-cancel-add').addEventListener('click', closeModal);
  document.getElementById('search-username-input').addEventListener('input', searchUserPreview);
  document.getElementById('search-username-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addContact();
    if (e.key === 'Escape') closeModal();
  });

  // Chat input
  document.getElementById('btn-send').addEventListener('click', sendMessage);
  document.getElementById('msg-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); sendMessage(); }
  });
  document.getElementById('msg-input').addEventListener('input', onMsgInput);
  document.getElementById('btn-back').addEventListener('click', closeChat);

  // Profile modal
  document.getElementById('btn-save-profile').addEventListener('click', saveProfile);
  document.getElementById('btn-close-profile').addEventListener('click', () => document.getElementById('modal-profile').classList.add('hidden'));
  document.getElementById('btn-change-password').addEventListener('click', changePassword);
  document.getElementById('btn-logout').addEventListener('click', () => { if (confirm('Выйти из аккаунта?')) logout(); });
  document.getElementById('btn-copy-id').addEventListener('click', () => {
    navigator.clipboard.writeText(state.userId).then(() => {
      const btn = document.getElementById('btn-copy-id');
      btn.textContent = 'Скопировано!'; setTimeout(() => { btn.textContent = 'Копировать'; }, 1500);
    });
  });
  document.getElementById('profile-avatar-preview').addEventListener('click', () => document.getElementById('avatar-file-input').click());
  document.getElementById('avatar-file-input').addEventListener('change', e => { const f = e.target.files[0]; if (f) uploadAvatar(f); });

  // Peer profile
  document.getElementById('btn-close-peer-profile').addEventListener('click', () => document.getElementById('modal-peer-profile').classList.add('hidden'));
  document.getElementById('chat-peer-avatar').addEventListener('click', () => { if (state.activeContact) openPeerProfile(state.activeContact); });
  document.getElementById('chat-peer-info-click').addEventListener('click', () => { if (state.activeContact) openPeerProfile(state.activeContact); });

  // ESC — закрыть чат (на десктопе) или модалки
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!document.getElementById('modal-profile').classList.contains('hidden')) {
        document.getElementById('modal-profile').classList.add('hidden'); return;
      }
      if (!document.getElementById('modal-peer-profile').classList.contains('hidden')) {
        document.getElementById('modal-peer-profile').classList.add('hidden'); return;
      }
      if (!document.getElementById('modal-add').classList.contains('hidden')) {
        closeModal(); return;
      }
      // На десктопе ESC закрывает чат
      if (state.activeContact && window.innerWidth > 640) closeChat();
    }
  });
}

// --- Utils ---
function notifyTitle(name, text) {
  const orig = document.title;
  document.title = `(1) ${name}: ${text.slice(0, 30)}`;
  setTimeout(() => { document.title = orig; }, 4000);
}

function fmtTime(ts) {
  const d = new Date(ts * 1000), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'short' });
}

function fmtLastSeen(ts) {
  const d = new Date(ts * 1000), now = new Date();
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60) return 'только что';
  if (diff < 3600) return Math.floor(diff / 60) + ' мин. назад';
  if (d.toDateString() === now.toDateString()) return 'сегодня в ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'short' }) + ' в ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
