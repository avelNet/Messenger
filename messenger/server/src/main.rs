mod db;

use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
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
        "avatar_color": u.avatar_color, "last_seen": u.last_seen
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
                        display_name: String::new(), bio: String::new(),
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
        .route("/history/:user_id", get(history))
        .route("/push/subscribe", post(save_push_sub))
        .route("/ws", get(ws_handler))
        .nest_service("/", ServeDir::new("client"))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let port = std::env::var("PORT").unwrap_or_else(|_| "3000".to_string());
    let addr = format!("0.0.0.0:{}", port);
    println!("Server on http://{}", addr);
    axum::serve(tokio::net::TcpListener::bind(&addr).await.unwrap(), app).await.unwrap();
}
