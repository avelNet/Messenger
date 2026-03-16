mod db;

use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, Multipart, Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use base64::Engine as _;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::sync::Arc;
use tokio::sync::mpsc;
use tower_http::{cors::CorsLayer, services::ServeDir};
use uuid::Uuid;

type UserTx = mpsc::UnboundedSender<String>;

#[derive(Clone)]
struct AppState {
    db: SqlitePool,
    connections: Arc<DashMap<String, UserTx>>,
}

// --- Auth ---

#[derive(Deserialize)]
struct RegisterRequest { username: String, password: String }

#[derive(Deserialize)]
struct LoginRequest { username: String, password: String }

#[derive(Serialize)]
struct AuthResponse { id: String, username: String, display_name: String, avatar_color: String }

async fn register(State(s): State<AppState>, Json(req): Json<RegisterRequest>) -> (StatusCode, Json<serde_json::Value>) {
    let username = req.username.trim().to_lowercase();
    if username.is_empty() || username.len() > 32 || req.password.len() < 4 {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid input"})));
    }
    if db::get_user_by_username(&s.db, &username).await.ok().flatten().is_some() {
        return (StatusCode::CONFLICT, Json(serde_json::json!({"error": "Username taken"})));
    }
    let hash = bcrypt::hash(&req.password, 10).unwrap();
    let id = Uuid::new_v4().to_string()[..8].to_string();
    match db::create_user(&s.db, &id, &username, &hash).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({
            "id": id, "username": username,
            "display_name": username, "avatar_color": "#4f8ef7"
        }))),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB error"}))),
    }
}

async fn login(State(s): State<AppState>, Json(req): Json<LoginRequest>) -> (StatusCode, Json<serde_json::Value>) {
    let username = req.username.trim().to_lowercase();
    match db::get_user_by_username(&s.db, &username).await.ok().flatten() {
        Some(user) => {
            if bcrypt::verify(&req.password, &user.password_hash).unwrap_or(false) {
                (StatusCode::OK, Json(serde_json::json!({
                    "id": user.id, "username": user.username,
                    "display_name": user.display_name, "avatar_color": user.avatar_color
                })))
            } else {
                (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Wrong password"})))
            }
        }
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "User not found"}))),
    }
}

fn user_json(u: &db::User) -> serde_json::Value {
    serde_json::json!({
        "id": u.id, "username": u.username,
        "display_name": u.display_name, "bio": u.bio,
        "avatar_color": u.avatar_color, "avatar": u.avatar,
        "last_seen": u.last_seen
    })
}

async fn lookup(State(s): State<AppState>, Path(id): Path<String>) -> Result<Json<serde_json::Value>, StatusCode> {
    match db::get_user(&s.db, &id).await.ok().flatten() {
        Some(u) => Ok(Json(user_json(&u))),
        None => Err(StatusCode::NOT_FOUND),
    }
}

async fn lookup_by_username(State(s): State<AppState>, Path(username): Path<String>) -> Result<Json<serde_json::Value>, StatusCode> {
    match db::get_user_by_username(&s.db, &username.to_lowercase()).await.ok().flatten() {
        Some(u) => Ok(Json(user_json(&u))),
        None => Err(StatusCode::NOT_FOUND),
    }
}

#[derive(Deserialize)]
struct UpdateProfileRequest { id: String, display_name: String, bio: String, avatar_color: String }

async fn update_profile(State(s): State<AppState>, Json(req): Json<UpdateProfileRequest>) -> StatusCode {
    match db::update_profile(&s.db, &req.id, &req.display_name, &req.bio, &req.avatar_color).await {
        Ok(_) => StatusCode::OK,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

#[derive(Deserialize)]
struct ChangePasswordRequest { id: String, old_password: String, new_password: String }

async fn change_password(State(s): State<AppState>, Json(req): Json<ChangePasswordRequest>) -> (StatusCode, Json<serde_json::Value>) {
    match db::get_user(&s.db, &req.id).await.ok().flatten() {
        Some(user) => {
            if !bcrypt::verify(&req.old_password, &user.password_hash).unwrap_or(false) {
                return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Неверный пароль"})));
            }
            if req.new_password.len() < 4 {
                return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Пароль слишком короткий"})));
            }
            let hash = bcrypt::hash(&req.new_password, 10).unwrap();
            match db::update_password(&s.db, &req.id, &hash).await {
                Ok(_) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))),
                Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB error"}))),
            }
        }
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "User not found"}))),
    }
}

async fn upload_avatar(State(s): State<AppState>, mut multipart: Multipart) -> (StatusCode, Json<serde_json::Value>) {
    let mut user_id = String::new();
    let mut image_data: Option<Vec<u8>> = None;
    let mut mime = String::from("image/jpeg");

    while let Ok(Some(mut field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        if name == "user_id" {
            user_id = field.text().await.unwrap_or_default();
        } else if name == "avatar" {
            mime = field.content_type().unwrap_or("image/jpeg").to_string();
            let data: bytes::Bytes = field.bytes().await.unwrap_or_default();
            if data.len() > 2 * 1024 * 1024 {
                return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Файл слишком большой (макс 2MB)"})));
            }
            image_data = Some(data.to_vec());
        }
    }

    if user_id.is_empty() || image_data.is_none() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Missing fields"})));
    }

    let encoded = base64::engine::general_purpose::STANDARD.encode(image_data.unwrap());
    let data_url = format!("data:{};base64,{}", mime, encoded);

    match db::update_avatar(&s.db, &user_id, &data_url).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({"avatar": data_url}))),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB error"}))),
    }
}

#[derive(Deserialize)]
struct HistoryParams { with: String }

async fn history(State(s): State<AppState>, Path(uid): Path<String>, Query(q): Query<HistoryParams>) -> Result<Json<Vec<db::StoredMessage>>, StatusCode> {
    db::get_history(&s.db, &uid, &q.with, 100).await
        .map(Json).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[derive(Deserialize)]
struct PushSubRequest { user_id: String, endpoint: String, p256dh: String, auth: String }

async fn save_push_sub(State(s): State<AppState>, Json(req): Json<PushSubRequest>) -> StatusCode {
    match db::save_push_subscription(&s.db, &req.user_id, &req.endpoint, &req.p256dh, &req.auth).await {
        Ok(_) => StatusCode::OK,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

// --- WebSocket ---

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WsMsg {
    Auth { user_id: String },
    Send { to: String, text: String },
    Incoming { id: i64, from: String, from_name: String, from_color: String, text: String, timestamp: i64 },
    Delivered { id: i64 },
    Read { msg_ids: Vec<i64>, by: String },
    MarkRead { from: String },
    Typing { to: String },
    TypingIndicator { from: String, from_name: String },
    Authed { user_id: String, username: String, display_name: String, avatar_color: String },
    Presence { user_id: String, online: bool, last_seen: i64 },
    Error { message: String },
    ForceLogout,
}

async fn ws_handler(ws: WebSocketUpgrade, State(s): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, s))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender.send(Message::Text(msg.into())).await.is_err() { break; }
        }
    });

    let mut authed_id: Option<String> = None;

    while let Some(Ok(msg)) = receiver.next().await {
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            _ => continue,
        };
        let parsed: WsMsg = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(_) => continue,
        };

        match parsed {
            WsMsg::Auth { user_id } => {
                if let Ok(Some(user)) = db::get_user(&state.db, &user_id).await {
                    state.connections.insert(user_id.clone(), tx.clone());
                    authed_id = Some(user_id.clone());
                    broadcast_presence(&state, &user_id, true, 0);

                    // Доставить оффлайн сообщения
                    if let Ok(pending) = db::get_undelivered(&state.db, &user_id).await {
                        for m in pending {
                            let from_color = db::get_user(&state.db, &m.from_id).await
                                .ok().flatten().map(|u| u.avatar_color).unwrap_or_default();
                            let from_name = db::get_user(&state.db, &m.from_id).await
                                .ok().flatten().map(|u| u.display_name).unwrap_or_default();
                            let _ = tx.send(serde_json::to_string(&WsMsg::Incoming {
                                id: m.id, from: m.from_id.clone(), from_name, from_color,
                                text: m.text, timestamp: m.timestamp,
                            }).unwrap());
                            let _ = db::mark_delivered(&state.db, m.id).await;
                        }
                    }

                    let _ = tx.send(serde_json::to_string(&WsMsg::Authed {
                        user_id, username: user.username,
                        display_name: user.display_name, avatar_color: user.avatar_color,
                    }).unwrap());
                } else {
                    let _ = tx.send(serde_json::to_string(&WsMsg::Error { message: "User not found".into() }).unwrap());
                }
            }

            WsMsg::Send { to, text } => {
                if let Some(ref from_id) = authed_id {
                    let user = db::get_user(&state.db, from_id).await.ok().flatten().unwrap_or_else(|| db::User {
                        id: from_id.clone(), username: String::new(), password_hash: String::new(),
                        display_name: String::new(), bio: String::new(), avatar: String::new(),
                        avatar_color: "#4f8ef7".into(), last_seen: 0, created_at: 0,
                    });
                    let timestamp = chrono::Utc::now().timestamp();
                    let msg_id = db::save_message(&state.db, from_id, &to, &text, timestamp).await.unwrap_or(0);

                    let incoming = serde_json::to_string(&WsMsg::Incoming {
                        id: msg_id, from: from_id.clone(),
                        from_name: user.display_name.clone(),
                        from_color: user.avatar_color.clone(),
                        text: text.clone(), timestamp,
                    }).unwrap();

                    if let Some(rtx) = state.connections.get(&to) {
                        let _ = rtx.send(incoming);
                        let _ = db::mark_delivered(&state.db, msg_id).await;
                        // Уведомить отправителя что доставлено
                        let _ = tx.send(serde_json::to_string(&WsMsg::Delivered { id: msg_id }).unwrap());
                    } else {
                        // Оффлайн — push
                        let db = state.db.clone();
                        let (to2, name, txt) = (to.clone(), user.display_name.clone(), text.clone());
                        tokio::spawn(async move {
                            send_push(&db, &to2, &name, &txt).await;
                        });
                    }
                }
            }

            WsMsg::MarkRead { from } => {
                if let Some(ref my_id) = authed_id {
                    if let Ok(ids) = db::mark_read(&state.db, &from, my_id).await {
                        if !ids.is_empty() {
                            if let Some(ftx) = state.connections.get(&from) {
                                let _ = ftx.send(serde_json::to_string(&WsMsg::Read {
                                    msg_ids: ids, by: my_id.clone(),
                                }).unwrap());
                            }
                        }
                    }
                }
            }

            WsMsg::Typing { to } => {
                if let Some(ref from_id) = authed_id {
                    let from_name = db::get_user(&state.db, from_id).await
                        .ok().flatten().map(|u| u.display_name).unwrap_or_default();
                    if let Some(rtx) = state.connections.get(&to) {
                        let _ = rtx.send(serde_json::to_string(&WsMsg::TypingIndicator {
                            from: from_id.clone(), from_name,
                        }).unwrap());
                    }
                }
            }

            _ => {}
        }
    }

    if let Some(ref id) = authed_id {
        state.connections.remove(id);
        let last_seen = chrono::Utc::now().timestamp();
        let _ = db::update_last_seen(&state.db, id).await;
        broadcast_presence(&state, id, false, last_seen);
    }
    send_task.abort();
}

fn broadcast_presence(state: &AppState, user_id: &str, online: bool, last_seen: i64) {
    let msg = serde_json::to_string(&WsMsg::Presence { user_id: user_id.to_string(), online, last_seen }).unwrap();
    for entry in state.connections.iter() {
        if entry.key() != user_id { let _ = entry.value().send(msg.clone()); }
    }
}

async fn send_push(db: &SqlitePool, user_id: &str, from_name: &str, text: &str) {
    if let Ok(Some((endpoint, p256dh, auth))) = db::get_push_subscription(db, user_id).await {
        use web_push::*;
        let subscription = SubscriptionInfo { endpoint, keys: SubscriptionKeys { p256dh, auth } };
        let vapid_key = std::env::var("VAPID_PRIVATE_KEY").unwrap_or_default();
        if vapid_key.is_empty() { return; }
        let payload = serde_json::json!({"title": from_name, "body": text}).to_string();
        let sig_builder = VapidSignatureBuilder::from_base64(&vapid_key, URL_SAFE_NO_PAD, &subscription);
        if let Ok(sig) = sig_builder.and_then(|b| b.build()) {
            let mut builder = WebPushMessageBuilder::new(&subscription);
            builder.set_payload(ContentEncoding::Aes128Gcm, payload.as_bytes());
            builder.set_vapid_signature(sig);
            if let Ok(msg) = builder.build() {
                let client = IsahcWebPushClient::new().unwrap();
                let _ = client.send(msg).await;
            }
        }
    }
}

fn check_admin_token(token: &str) -> bool {
    let admin_token = std::env::var("ADMIN_TOKEN").unwrap_or_else(|_| "changeme".to_string());
    !admin_token.is_empty() && token == admin_token
}

#[derive(Deserialize)]
struct AdminQuery { token: String }

async fn admin_page(Query(q): Query<AdminQuery>) -> impl IntoResponse {
    if !check_admin_token(&q.token) {
        return axum::response::Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(axum::body::Body::from("Unauthorized"))
            .unwrap();
    }
    let token = q.token.clone();
    let html = format!(r#"<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Admin Panel</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e2e8f0;padding:24px}}
h1{{font-size:1.4rem;margin-bottom:20px;color:#a78bfa}}
.stats{{display:flex;gap:16px;margin-bottom:24px}}
.stat{{background:#1a1a24;border:1px solid #2a2a3a;border-radius:10px;padding:16px 24px;text-align:center}}
.stat-val{{font-size:2rem;font-weight:700;color:#6c63ff}}
.stat-label{{font-size:.8rem;color:#8888aa;margin-top:4px}}
table{{width:100%;border-collapse:collapse;background:#111118;border-radius:10px;overflow:hidden}}
th{{background:#1a1a24;padding:12px 16px;text-align:left;font-size:.8rem;color:#8888aa;font-weight:500}}
td{{padding:11px 16px;border-top:1px solid #1a1a24;font-size:.85rem}}
tr:hover td{{background:#1a1a24}}
.badge{{background:#2d2060;color:#a78bfa;padding:2px 8px;border-radius:6px;font-size:.75rem;font-family:monospace}}
.del-btn{{background:#3a1a1a;border:1px solid #5a2a2a;color:#f87171;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:.8rem}}
.del-btn:hover{{background:#5a2a2a}}
.online-dot{{display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;margin-right:6px}}
.offline-dot{{display:inline-block;width:8px;height:8px;border-radius:50%;background:#555570;margin-right:6px}}
</style>
</head>
<body>
<h1>⚙ Admin Panel</h1>
<div style="font-size:.75rem;color:#555570;margin-bottom:12px">Обновляется каждые 3 сек &nbsp;<span id="last-update"></span></div>
<div class="stats" id="stats">Загрузка...</div>
<table>
<thead><tr><th>Пользователь</th><th>ID</th><th>Онлайн</th><th>Последний вход</th><th>Сообщений</th><th>Регистрация</th><th></th></tr></thead>
<tbody id="users-tbody">Загрузка...</tbody>
</table>
<script>
const TOKEN = '{token}';
async function deleteUser(id, username) {{
  if (!confirm('Удалить @' + username + '? Все сообщения тоже удалятся.')) return;
  await fetch('/admin/delete/' + id + '?token=' + TOKEN, {{method:'POST'}});
  load();
}}
function fmtDate(ts) {{
  return new Date(ts * 1000).toLocaleString('ru', {{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}});
}}
function esc(s) {{ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }}
async function load() {{
  try {{
    const res = await fetch('/admin/users?token=' + TOKEN);
    const data = await res.json();
    document.getElementById('stats').innerHTML = `
      <div class="stat"><div class="stat-val">${{data.total_users}}</div><div class="stat-label">Пользователей</div></div>
      <div class="stat"><div class="stat-val">${{data.total_messages}}</div><div class="stat-label">Сообщений</div></div>
      <div class="stat"><div class="stat-val">${{data.online_now}}</div><div class="stat-label">Онлайн сейчас</div></div>
    `;
    const tbody = document.getElementById('users-tbody');
    tbody.innerHTML = data.users.map(u => `
      <tr>
        <td><strong>${{esc(u.display_name)}}</strong><br><span style="color:#8888aa;font-size:.78rem">@${{esc(u.username)}}</span></td>
        <td><span class="badge">${{u.id}}</span></td>
        <td>${{u.online ? '<span class="online-dot"></span>онлайн' : '<span class="offline-dot"></span>оффлайн'}}</td>
        <td style="color:#8888aa">${{u.last_seen ? fmtDate(u.last_seen) : '—'}}</td>
        <td>${{u.msg_count}}</td>
        <td style="color:#8888aa">${{fmtDate(u.created_at)}}</td>
        <td><button class="del-btn" onclick="deleteUser('${{u.id}}','${{esc(u.username)}}')">Удалить</button></td>
      </tr>
    `).join('');
    document.getElementById('last-update').textContent = 'обновлено в ' + new Date().toLocaleTimeString('ru');
  }} catch(e) {{
    document.getElementById('last-update').textContent = '⚠ ошибка соединения';
  }}
}}
load();
setInterval(load, 3000);
</script>
</body>
</html>"#, token = token);

    axum::response::Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Cache-Control", "no-store")
        .body(axum::body::Body::from(html))
        .unwrap()
}

async fn admin_users(
    State(s): State<AppState>,
    Query(q): Query<AdminQuery>,
) -> (StatusCode, Json<serde_json::Value>) {
    if !check_admin_token(&q.token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error":"Unauthorized"})));
    }
    let users = db::get_all_users(&s.db).await.unwrap_or_default();
    let (total_users, total_messages) = db::get_stats(&s.db).await.unwrap_or((0, 0));
    let online_now = s.connections.len() as i64;
    let users_json: Vec<serde_json::Value> = users.iter().map(|u| {
        let online = s.connections.contains_key(&u.id);
        serde_json::json!({
            "id": u.id, "username": u.username, "display_name": u.display_name,
            "last_seen": u.last_seen, "created_at": u.created_at,
            "msg_count": u.msg_count, "online": online,
        })
    }).collect();
    (StatusCode::OK, Json(serde_json::json!({
        "users": users_json,
        "total_users": total_users,
        "total_messages": total_messages,
        "online_now": online_now,
    })))
}

async fn admin_delete_user(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<AdminQuery>,
) -> StatusCode {
    if !check_admin_token(&q.token) { return StatusCode::UNAUTHORIZED; }
    // Отправить force logout и отключить
    if let Some(tx) = s.connections.get(&id) {
        let _ = tx.send(serde_json::to_string(&WsMsg::ForceLogout).unwrap());
    }
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    s.connections.remove(&id);
    match db::delete_user(&s.db, &id).await {
        Ok(_) => StatusCode::OK,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

#[tokio::main]
async fn main() {
    let db_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite:///data/messenger.db".to_string());
    let db = db::init(&db_url).await;
    let state = AppState { db, connections: Arc::new(DashMap::new()) };

    let app = Router::new()
        .route("/register", post(register))
        .route("/login", post(login))
        .route("/user/:id", get(lookup))
        .route("/username/:username", get(lookup_by_username))
        .route("/profile", post(update_profile))
        .route("/password", post(change_password))
        .route("/avatar", post(upload_avatar))
        .route("/history/:user_id", get(history))
        .route("/push/subscribe", post(save_push_sub))
        .route("/admin", get(admin_page))
        .route("/admin/users", get(admin_users))
        .route("/admin/delete/:id", post(admin_delete_user))
        .route("/ws", get(ws_handler))
        .nest_service("/", ServeDir::new("client"))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let port = std::env::var("PORT").unwrap_or_else(|_| "3000".to_string());
    let addr = format!("0.0.0.0:{}", port);
    println!("Server on http://{}", addr);
    axum::serve(tokio::net::TcpListener::bind(&addr).await.unwrap(), app).await.unwrap();
}
