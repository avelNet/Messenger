# Messenger

Локальный мессенджер: Rust сервер + PWA клиент.

## Что нужно установить

- [Rust](https://rustup.rs/) — установщик одной командой

## Запуск локально (для разработки)

```bash
cd messenger/server
cargo run
```

Открой браузер: http://localhost:3000

## Деплой сервера (чтобы работало через интернет)

### Вариант 1 — Railway (бесплатно)
1. Зарегистрируйся на https://railway.app
2. New Project → Deploy from GitHub → выбери репозиторий
3. Укажи root directory: `messenger/server`
4. Railway сам соберёт и запустит

### Вариант 2 — любой VPS
```bash
cd messenger/server
cargo build --release
./target/release/messenger-server
```

## После деплоя

В файле `messenger/client/app.js` строка 2:
```js
const SERVER_URL = window.location.origin; // уже правильно, менять не нужно
```

Сервер сам раздаёт клиент из папки `../client`, так что всё работает автоматически.

## Структура

```
messenger/
├── server/src/main.rs   # Rust: HTTP + WebSocket
└── client/
    ├── index.html
    ├── style.css
    ├── app.js
    └── manifest.json    # PWA
```
