const SERVER_URL = window.location.origin;
const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/ws';

// VAPID public key — сгенерируй и замени (см. README)
const VAPID_PUBLIC_KEY = 'YOUR_VAPID_PUBLIC_KEY';

// --- Storage ---
const store = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

// --- State ---
let state = {
  userId: null,
  username: null,
  contacts: {},
  messages: {},
  activeContact: null,
  ws: null,
  wsReady: false,
};

// --- Init ---
window.addEventListener('DOMContentLoaded', async () => {
  const saved = store.get('user');
  if (saved?.id && saved?.username) {
    state.userId = saved.id;
    state.username = saved.username;
    state.contacts = store.get('contacts') || {};
    state.messages = store.get('messages') || {};
    showMain();
    connectWs();
  } else {
    showAuth();
  }
  bindEvents();
});

// --- Auth ---
function showAuth() {
  document.getElementById('screen-auth').classList.remove('hidden');
  document.getElementById('screen-main').classList.add('hidden');
}

function showMain() {
  document.getElementById('screen-auth').classList.add('hidden');
  document.getElementById('screen-main').classList.remove('hidden');
  document.getElementById('my-username').textContent = state.username;
  document.getElementById('my-id').textContent = state.userId;
  renderContacts();
}

async function register() {
  const username = document.getElementById('input-username').value.trim();
  if (!username) return;
  const errEl = document.getElementById('auth-error');
  errEl.textContent = '';
  try {
    const res = await fetch(`${SERVER_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    if (!res.ok) throw new Error();
    const data = await res.json();
    state.userId = data.id;
    state.username = data.username;
    store.set('user', { id: data.id, username: data.username });
    showMain();
    connectWs();
  } catch {
    errEl.textContent = 'Не удалось подключиться к серверу';
  }
}

// --- WebSocket ---
function connectWs() {
  if (state.ws) { try { state.ws.close(); } catch {} }

  const ws = new WebSocket(WS_URL);
  state.ws = ws;
  state.wsReady = false;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', user_id: state.userId }));
  };

  ws.onmessage = (e) => handleWsMessage(JSON.parse(e.data));

  ws.onclose = () => {
    state.wsReady = false;
    setTimeout(connectWs, 3000);
  };

  ws.onerror = () => ws.close();
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'authed':
      state.wsReady = true;
      setupPush();
      break;

    case 'incoming': {
      const { id, from, from_name, text, timestamp } = msg;
      if (!state.contacts[from]) {
        state.contacts[from] = { id: from, username: from_name, online: true };
        saveContacts();
        renderContacts();
      }
      pushMessage(from, { id, from, text, timestamp, out: false });
      if (state.activeContact !== from) notifyContact(from, from_name, text);
      break;
    }

    case 'presence': {
      const { user_id, online } = msg;
      if (state.contacts[user_id]) {
        state.contacts[user_id].online = online;
        saveContacts();
        renderContacts();
        if (state.activeContact === user_id) updateChatStatus(online);
      }
      break;
    }

    case 'error':
      console.warn('Server:', msg.message);
      break;
  }
}

function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text || !state.activeContact || !state.wsReady) return;

  state.ws.send(JSON.stringify({ type: 'send', to: state.activeContact, text }));

  const timestamp = Math.floor(Date.now() / 1000);
  pushMessage(state.activeContact, { from: state.userId, text, timestamp, out: true });
  input.value = '';
}

// --- History ---
async function loadHistory(contactId) {
  try {
    const res = await fetch(`${SERVER_URL}/history/${state.userId}?with=${contactId}`);
    if (!res.ok) return;
    const msgs = await res.json();
    // Смержить с локальными (избежать дублей по id)
    const existing = new Set((state.messages[contactId] || []).map(m => m.id).filter(Boolean));
    const newMsgs = msgs
      .filter(m => !existing.has(m.id))
      .map(m => ({
        id: m.id,
        from: m.from_id,
        text: m.text,
        timestamp: m.timestamp,
        out: m.from_id === state.userId,
      }));
    if (newMsgs.length > 0) {
      state.messages[contactId] = [
        ...newMsgs,
        ...(state.messages[contactId] || []),
      ].sort((a, b) => a.timestamp - b.timestamp);
      store.set('messages', state.messages);
      renderMessages(contactId);
    }
  } catch {}
}

// --- Contacts ---
async function addContact() {
  const id = document.getElementById('input-contact-id').value.trim().toLowerCase();
  const errEl = document.getElementById('add-error');
  errEl.textContent = '';

  if (!id || id.length !== 8) { errEl.textContent = 'ID должен быть 8 символов'; return; }
  if (id === state.userId) { errEl.textContent = 'Нельзя добавить себя'; return; }

  try {
    const res = await fetch(`${SERVER_URL}/user/${id}`);
    if (!res.ok) throw new Error();
    const user = await res.json();
    state.contacts[id] = { id, username: user.username, online: false };
    saveContacts();
    renderContacts();
    closeModal();
  } catch {
    errEl.textContent = 'Пользователь не найден';
  }
}

function saveContacts() { store.set('contacts', state.contacts); }

function renderContacts() {
  const list = document.getElementById('contacts-list');
  list.innerHTML = '';
  const contacts = Object.values(state.contacts);
  if (!contacts.length) {
    list.innerHTML = '<p style="padding:16px;color:var(--text2);font-size:0.85rem">Нет контактов. Нажмите + чтобы добавить.</p>';
    return;
  }
  contacts.forEach(contact => {
    const el = document.createElement('div');
    el.className = 'contact-item' + (state.activeContact === contact.id ? ' active' : '');
    el.innerHTML = `
      <div class="contact-avatar">
        ${contact.username[0].toUpperCase()}
        <span class="status-dot ${contact.online ? 'online' : ''}"></span>
      </div>
      <div class="contact-info">
        <div class="contact-name">${escHtml(contact.username)}</div>
        <div class="contact-id">${contact.id}</div>
      </div>`;
    el.addEventListener('click', () => openChat(contact.id));
    list.appendChild(el);
  });
}

function openChat(contactId) {
  state.activeContact = contactId;
  const contact = state.contacts[contactId];
  document.getElementById('chat-title').textContent = contact.username;
  updateChatStatus(contact.online);
  document.getElementById('msg-input').disabled = false;
  document.getElementById('btn-send').disabled = false;
  renderMessages(contactId);
  renderContacts();
  loadHistory(contactId);
  if (window.innerWidth <= 600) {
    document.querySelector('.sidebar').classList.add('hidden-mobile');
  }
}

function updateChatStatus(online) {
  const el = document.getElementById('chat-status');
  el.textContent = online ? 'онлайн' : '';
}

// --- Messages ---
function pushMessage(contactId, msg) {
  if (!state.messages[contactId]) state.messages[contactId] = [];
  // Избежать дублей
  if (msg.id && state.messages[contactId].some(m => m.id === msg.id)) return;
  state.messages[contactId].push(msg);
  store.set('messages', state.messages);
  if (state.activeContact === contactId) renderMessages(contactId);
}

function renderMessages(contactId) {
  const container = document.getElementById('messages');
  const msgs = state.messages[contactId] || [];
  container.innerHTML = '';
  msgs.forEach(msg => {
    const el = document.createElement('div');
    el.className = 'msg ' + (msg.out ? 'out' : 'in');
    const time = new Date(msg.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `${escHtml(msg.text)}<div class="msg-time">${time}</div>`;
    container.appendChild(el);
  });
  container.scrollTop = container.scrollHeight;
}

function notifyContact(contactId, name, text) {
  const orig = document.title;
  document.title = `(1) ${name}: ${text.slice(0, 30)}`;
  setTimeout(() => { document.title = orig; }, 4000);
}

// --- Push notifications ---
async function setupPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (VAPID_PUBLIC_KEY === 'YOUR_VAPID_PUBLIC_KEY') return;

  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });

    const { endpoint, keys } = sub.toJSON();
    await fetch(`${SERVER_URL}/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: state.userId,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      }),
    });
  } catch (e) {
    console.warn('Push setup failed:', e);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

// --- Modal ---
function openModal() {
  document.getElementById('modal-add').classList.remove('hidden');
  document.getElementById('input-contact-id').value = '';
  document.getElementById('add-error').textContent = '';
  document.getElementById('input-contact-id').focus();
}
function closeModal() { document.getElementById('modal-add').classList.add('hidden'); }

// --- Events ---
function bindEvents() {
  document.getElementById('btn-register').addEventListener('click', register);
  document.getElementById('input-username').addEventListener('keydown', e => { if (e.key === 'Enter') register(); });
  document.getElementById('btn-add-contact').addEventListener('click', openModal);
  document.getElementById('btn-confirm-add').addEventListener('click', addContact);
  document.getElementById('btn-cancel-add').addEventListener('click', closeModal);
  document.getElementById('input-contact-id').addEventListener('keydown', e => {
    if (e.key === 'Enter') addContact();
    if (e.key === 'Escape') closeModal();
  });
  document.getElementById('btn-send').addEventListener('click', sendMessage);
  document.getElementById('msg-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });
  document.getElementById('chat-header').addEventListener('click', () => {
    if (window.innerWidth <= 600) document.querySelector('.sidebar').classList.remove('hidden-mobile');
  });
  document.getElementById('my-id').addEventListener('click', () => {
    navigator.clipboard.writeText(state.userId).then(() => {
      const el = document.getElementById('my-id');
      const orig = el.textContent;
      el.textContent = 'скопировано!';
      setTimeout(() => { el.textContent = orig; }, 1500);
    });
  });
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
