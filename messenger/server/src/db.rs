use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};

pub async fn init(database_url: &str) -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(database_url)
        .await
        .expect("Failed to connect to SQLite");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_id TEXT NOT NULL,
            to_id TEXT NOT NULL,
            text TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            delivered INTEGER NOT NULL DEFAULT 0
        )",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS push_subscriptions (
            user_id TEXT PRIMARY KEY,
            endpoint TEXT NOT NULL,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL
        )",
    )
    .execute(&pool)
    .await
    .unwrap();

    pool
}

#[derive(sqlx::FromRow, serde::Serialize, serde::Deserialize, Clone)]
pub struct User {
    pub id: String,
    pub username: String,
    pub created_at: i64,
}

#[derive(sqlx::FromRow, serde::Serialize, serde::Deserialize, Clone)]
pub struct StoredMessage {
    pub id: i64,
    pub from_id: String,
    pub to_id: String,
    pub text: String,
    pub timestamp: i64,
    pub delivered: i64,
}

pub async fn create_user(pool: &SqlitePool, id: &str, username: &str) -> anyhow::Result<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query("INSERT INTO users (id, username, created_at) VALUES (?, ?, ?)")
        .bind(id)
        .bind(username)
        .bind(now)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_user(pool: &SqlitePool, id: &str) -> anyhow::Result<Option<User>> {
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(user)
}

pub async fn save_message(
    pool: &SqlitePool,
    from_id: &str,
    to_id: &str,
    text: &str,
    timestamp: i64,
) -> anyhow::Result<i64> {
    let res = sqlx::query(
        "INSERT INTO messages (from_id, to_id, text, timestamp, delivered) VALUES (?, ?, ?, ?, 0)",
    )
    .bind(from_id)
    .bind(to_id)
    .bind(text)
    .bind(timestamp)
    .execute(pool)
    .await?;
    Ok(res.last_insert_rowid())
}

pub async fn mark_delivered(pool: &SqlitePool, msg_id: i64) -> anyhow::Result<()> {
    sqlx::query("UPDATE messages SET delivered = 1 WHERE id = ?")
        .bind(msg_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_undelivered(pool: &SqlitePool, to_id: &str) -> anyhow::Result<Vec<StoredMessage>> {
    let msgs = sqlx::query_as::<_, StoredMessage>(
        "SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY timestamp ASC",
    )
    .bind(to_id)
    .fetch_all(pool)
    .await?;
    Ok(msgs)
}

pub async fn get_history(
    pool: &SqlitePool,
    user_a: &str,
    user_b: &str,
    limit: i64,
) -> anyhow::Result<Vec<StoredMessage>> {
    let msgs = sqlx::query_as::<_, StoredMessage>(
        "SELECT * FROM messages
         WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
         ORDER BY timestamp DESC LIMIT ?",
    )
    .bind(user_a)
    .bind(user_b)
    .bind(user_b)
    .bind(user_a)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(msgs)
}

pub async fn save_push_subscription(
    pool: &SqlitePool,
    user_id: &str,
    endpoint: &str,
    p256dh: &str,
    auth: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT OR REPLACE INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)",
    )
    .bind(user_id)
    .bind(endpoint)
    .bind(p256dh)
    .bind(auth)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_push_subscription(
    pool: &SqlitePool,
    user_id: &str,
) -> anyhow::Result<Option<(String, String, String)>> {
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}
