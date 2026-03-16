mod db;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
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
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use uuid::Uuid;

type UserTx = mpsc::UnboundedSender<String>;

#[derive(Clone)]
struct AppState {
    db: SqlitePool,
    connections: Arc<DashMap<String, UserTx>>,
}

// --- REST ---

#[derive(Deserialize)]
struct RegisterRequest {
    username: String,
}

#[derive(Serialize)]
struct RegisterResponse {
    id: String,
    username: String,
}

async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    if req.username.trim().is_empty() || req.username.len() > 32 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid username"})),
        );
    }
    let id = Uuid::new_v4().to_string()[..8].to_string();
    match db::create_user(&state.db, &id, req.username.trim()).await {
        Ok(_) => {
            println!("[+] Registered: {} ({})", req.username, id);
            (StatusCode::OK, Json(serde_json::json!({"id": id, "username": req.username.trim()})))
        }
        Err(e) => {
            eprintln!("DB error: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB error"})))
        }
    }
}

async fn lookup(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<db::User>, StatusCode> {
    match db::get_user(&state.db, &id).await {
        Ok(Some(user)) => Ok(Json(user)),
        _ => Err(StatusCode::NOT_FOUND),
    }
}

#[derive(Deserialize)]
struct HistoryQuery {
    with: String,
}

async fn history(
    State(state): State<AppState>,
    Path(user_id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<HistoryQuery>,
) -> Result<Json<Vec<db::StoredMessage>>, StatusCode> {
    match db::get_history(&state.db, &user_id, &q.with, 100).await {
        Ok(msgs) => Ok(Json(msgs)),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

#[derive(Deserialize)]
struct PushSubRequest {
    user_id: String,
    endpoint: String,
    p256dh: String,
    auth: String,
}

async fn save_push_sub(
    State(state): State<AppState>,
    Json(req): Json<PushSubRequest>,
) -> StatusCode {
    match db::save_push_subscription(&state.db, &req.user_id, &req.endpoint, &req.p256dh, &req.auth).await {
        Ok(_) => StatusCode::OK,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

// --- WebSocket messages ---

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WsMessage {
    Auth { user_id: String },
    Send { to: String, text: String },
    Incoming { id: i64, from: String, from_name: String, text: String, timestamp: i64 },
    Authed { user_id: String, username: String },
    Error { message: String },
    Presence { user_id: String, online: bool },
}

// --- WebSocket handler ---

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    let mut authed_id: Option<String> = None;

    while let Some(Ok(msg)) = receiver.next().await {
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            _ => continue,
        };

        let parsed: WsMessage = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(_) => continue,
        };

        match parsed {
            WsMessage::Auth { user_id } => {
                match db::get_user(&state.db, &user_id).await {
                    Ok(Some(user)) => {
                        state.connections.insert(user_id.clone(), tx.clone());
                        authed_id = Some(user_id.clone());
                        broadcast_presence(&state, &user_id, true);

                        // Отправить накопленные оффлайн сообщения
                        if let Ok(pending) = db::get_undelivered(&state.db, &user_id).await {
                            for m in pending {
                                let from_name = db::get_user(&state.db, &m.from_id).await
                                    .ok().flatten()
                                    .map(|u| u.username)
                                    .unwrap_or_default();
                                let msg = serde_json::to_string(&WsMessage::Incoming {
                                    id: m.id,
                                    from: m.from_id.clone(),
                                    from_name,
                                    text: m.text,
                                    timestamp: m.timestamp,
                                }).unwrap();
                                let _ = tx.send(msg);
                                let _ = db::mark_delivered(&state.db, m.id).await;
                            }
                        }

                        let resp = serde_json::to_string(&WsMessage::Authed {
                            user_id,
                            username: user.username,
                        }).unwrap();
                        let _ = tx.send(resp);
                    }
                    _ => {
                        let _ = tx.send(serde_json::to_string(&WsMessage::Error {
                            message: "User not found".into(),
                        }).unwrap());
                    }
                }
            }

            WsMessage::Send { to, text } => {
                if let Some(ref from_id) = authed_id {
                    let from_name = db::get_user(&state.db, from_id).await
                        .ok().flatten()
                        .map(|u| u.username)
                        .unwrap_or_default();

                    let timestamp = chrono::Utc::now().timestamp();

                    // Сохранить в БД
                    let msg_id = db::save_message(&state.db, from_id, &to, &text, timestamp)
                        .await.unwrap_or(0);

                    let incoming = serde_json::to_string(&WsMessage::Incoming {
                        id: msg_id,
                        from: from_id.clone(),
                        from_name: from_name.clone(),
                        text: text.clone(),
                        timestamp,
                    }).unwrap();

                    if let Some(recipient_tx) = state.connections.get(&to) {
                        // Онлайн — доставить сразу
                        let _ = recipient_tx.send(incoming);
                        let _ = db::mark_delivered(&state.db, msg_id).await;
                    } else {
                        // Оффлайн — отправить push если есть подписка
                        let db = state.db.clone();
                        let to_clone = to.clone();
                        let from_name_clone = from_name.clone();
                        let text_clone = text.clone();
                        tokio::spawn(async move {
                            send_push_notification(&db, &to_clone, &from_name_clone, &text_clone).await;
                        });
                    }
                }
            }

            _ => {}
        }
    }

    if let Some(ref id) = authed_id {
        state.connections.remove(id);
        broadcast_presence(&state, id, false);
        println!("[-] Disconnected: {}", id);
    }

    send_task.abort();
}

fn broadcast_presence(state: &AppState, user_id: &str, online: bool) {
    let msg = serde_json::to_string(&WsMessage::Presence {
        user_id: user_id.to_string(),
        online,
    }).unwrap();
    for entry in state.connections.iter() {
        if entry.key() != user_id {
            let _ = entry.value().send(msg.clone());
        }
    }
}

async fn send_push_notification(db: &SqlitePool, user_id: &str, from_name: &str, text: &str) {
    if let Ok(Some((endpoint, p256dh, auth))) = db::get_push_subscription(db, user_id).await {
        use web_push::*;
        let subscription = SubscriptionInfo {
            endpoint,
            keys: SubscriptionKeys { p256dh, auth },
        };
        let vapid_key = std::env::var("VAPID_PRIVATE_KEY").unwrap_or_default();
        if vapid_key.is_empty() { return; }

        let payload = serde_json::json!({
            "title": from_name,
            "body": text,
        }).to_string();

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

// --- Main ---

#[tokio::main]
async fn main() {
    let db_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "sqlite://messenger.db".to_string());

    let db = db::init(&db_url).await;

    let state = AppState {
        db,
        connections: Arc::new(DashMap::new()),
    };

    let app = Router::new()
        .route("/register", post(register))
        .route("/user/:id", get(lookup))
        .route("/history/:user_id", get(history))
        .route("/push/subscribe", post(save_push_sub))
        .route("/ws", get(ws_handler))
        .nest_service("/", ServeDir::new("client"))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let port = std::env::var("PORT").unwrap_or_else(|_| "3000".to_string());
    let addr = format!("0.0.0.0:{}", port);
    println!("Messenger server running on http://{}", addr);
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
