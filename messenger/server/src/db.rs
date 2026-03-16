use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};

pub async fn init(database_url: &str) -> SqlitePool {
    let path = database_url.trim_start_matches("sqlite://");
    if let Some(parent) = std::path::Path::new(path).parent() {
        std::fs::create_dir_all(parent).ok();
    }
    if !std::path::Path::new(path).exists() {
        std::fs::File::create(path).ok();
    }

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(database_url)
        .await
        .expect("Failed to connect to SQLite");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            display_name TEXT NOT NULL,
            bio TEXT NOT NULL DEFAULT '',
            avatar_color TEXT NOT NULL DEFAULT '#4f8ef7',
            avatar TEXT NOT NULL DEFAULT '',
            last_seen INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        )",
    ).execute(&pool).await.unwrap();

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_id TEXT NOT NULL,
            to_id TEXT NOT NULL,
            text TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            delivered INTEGER NOT NULL DEFAULT 0,
            read_at INTEGER NOT NULL DEFAULT 0
        )",
    ).execute(&pool).await.unwrap();

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS push_subscriptions (
            user_id TEXT PRIMARY KEY,
            endpoint TEXT NOT NULL,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL
        )",
    ).execute(&pool).await.unwrap();

    pool
}

#[derive(sqlx::FromRow, serde::Serialize, serde::Deserialize, Clone)]
pub struct User {
    pub id: String,
    pub username: String,
    pub password_hash: String,
    pub display_name: String,
    pub bio: String,
    pub avatar_color: String,
    pub avatar: String,
    pub last_seen: i64,
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
    pub read_at: i64,
}

pub async fn create_user(pool: &SqlitePool, id: &str, username: &str, password_hash: &str) -> anyhow::Result<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query("INSERT INTO users (id, username, password_hash, display_name, bio, avatar_color, avatar, last_seen, created_at) VALUES (?, ?, ?, ?, '', '#4f8ef7', '', ?, ?)")
        .bind(id).bind(username).bind(password_hash).bind(username).bind(now).bind(now)
        .execute(pool).await?;
    Ok(())
}

pub async fn get_user(pool: &SqlitePool, id: &str) -> anyhow::Result<Option<User>> {
    Ok(sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = ?")
        .bind(id).fetch_optional(pool).await?)
}

pub async fn get_user_by_username(pool: &SqlitePool, username: &str) -> anyhow::Result<Option<User>> {
    Ok(sqlx::query_as::<_, User>("SELECT * FROM users WHERE username = ?")
        .bind(username).fetch_optional(pool).await?)
}

pub async fn update_profile(pool: &SqlitePool, id: &str, display_name: &str, bio: &str, avatar_color: &str) -> anyhow::Result<()> {
    sqlx::query("UPDATE users SET display_name = ?, bio = ?, avatar_color = ? WHERE id = ?")
        .bind(display_name).bind(bio).bind(avatar_color).bind(id)
        .execute(pool).await?;
    Ok(())
}

pub async fn update_avatar(pool: &SqlitePool, id: &str, avatar: &str) -> anyhow::Result<()> {
    sqlx::query("UPDATE users SET avatar = ? WHERE id = ?")
        .bind(avatar).bind(id).execute(pool).await?;
    Ok(())
}

pub async fn update_password(pool: &SqlitePool, id: &str, hash: &str) -> anyhow::Result<()> {
    sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?")
        .bind(hash).bind(id).execute(pool).await?;
    Ok(())
}

pub async fn update_last_seen(pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query("UPDATE users SET last_seen = ? WHERE id = ?")
        .bind(now).bind(id).execute(pool).await?;
    Ok(())
}

pub async fn save_message(pool: &SqlitePool, from_id: &str, to_id: &str, text: &str, timestamp: i64) -> anyhow::Result<i64> {
    let res = sqlx::query("INSERT INTO messages (from_id, to_id, text, timestamp, delivered, read_at) VALUES (?, ?, ?, ?, 0, 0)")
        .bind(from_id).bind(to_id).bind(text).bind(timestamp)
        .execute(pool).await?;
    Ok(res.last_insert_rowid())
}

pub async fn mark_delivered(pool: &SqlitePool, msg_id: i64) -> anyhow::Result<()> {
    sqlx::query("UPDATE messages SET delivered = 1 WHERE id = ?")
        .bind(msg_id).execute(pool).await?;
    Ok(())
}

pub async fn mark_read(pool: &SqlitePool, from_id: &str, to_id: &str) -> anyhow::Result<Vec<i64>> {
    let now = chrono::Utc::now().timestamp();
    let ids: Vec<(i64,)> = sqlx::query_as("SELECT id FROM messages WHERE from_id = ? AND to_id = ? AND read_at = 0")
        .bind(from_id).bind(to_id).fetch_all(pool).await?;
    if !ids.is_empty() {
        sqlx::query("UPDATE messages SET read_at = ? WHERE from_id = ? AND to_id = ? AND read_at = 0")
            .bind(now).bind(from_id).bind(to_id).execute(pool).await?;
    }
    Ok(ids.into_iter().map(|(id,)| id).collect())
}

pub async fn get_undelivered(pool: &SqlitePool, to_id: &str) -> anyhow::Result<Vec<StoredMessage>> {
    Ok(sqlx::query_as::<_, StoredMessage>(
        "SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY timestamp ASC")
        .bind(to_id).fetch_all(pool).await?)
}

pub async fn get_history(pool: &SqlitePool, user_a: &str, user_b: &str, limit: i64) -> anyhow::Result<Vec<StoredMessage>> {
    let mut msgs = sqlx::query_as::<_, StoredMessage>(
        "SELECT * FROM messages WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?) ORDER BY timestamp DESC LIMIT ?")
        .bind(user_a).bind(user_b).bind(user_b).bind(user_a).bind(limit)
        .fetch_all(pool).await?;
    msgs.reverse();
    Ok(msgs)
}

pub async fn save_push_subscription(pool: &SqlitePool, user_id: &str, endpoint: &str, p256dh: &str, auth: &str) -> anyhow::Result<()> {
    sqlx::query("INSERT OR REPLACE INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)")
        .bind(user_id).bind(endpoint).bind(p256dh).bind(auth)
        .execute(pool).await?;
    Ok(())
}

pub async fn get_push_subscription(pool: &SqlitePool, user_id: &str) -> anyhow::Result<Option<(String, String, String)>> {
    Ok(sqlx::query_as("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?")
        .bind(user_id).fetch_optional(pool).await?)
}

#[derive(sqlx::FromRow, serde::Serialize)]
pub struct UserStats {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub last_seen: i64,
    pub created_at: i64,
    pub msg_count: i64,
}

pub async fn get_all_users(pool: &SqlitePool) -> anyhow::Result<Vec<UserStats>> {
    Ok(sqlx::query_as::<_, UserStats>(
        "SELECT u.id, u.username, u.display_name, u.last_seen, u.created_at,
         (SELECT COUNT(*) FROM messages WHERE from_id = u.id) as msg_count
         FROM users u ORDER BY u.created_at DESC",
    ).fetch_all(pool).await?)
}

pub async fn delete_user(pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM messages WHERE from_id = ? OR to_id = ?").bind(id).bind(id).execute(pool).await?;
    sqlx::query("DELETE FROM push_subscriptions WHERE user_id = ?").bind(id).execute(pool).await?;
    sqlx::query("DELETE FROM users WHERE id = ?").bind(id).execute(pool).await?;
    Ok(())
}

pub async fn get_stats(pool: &SqlitePool) -> anyhow::Result<(i64, i64)> {
    let (users,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users").fetch_one(pool).await?;
    let (msgs,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM messages").fetch_one(pool).await?;
    Ok((users, msgs))
}
