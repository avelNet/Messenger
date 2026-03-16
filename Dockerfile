FROM rust:1.76-slim as builder
RUN apt-get update && apt-get install -y pkg-config libssl-dev libsqlite3-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY messenger/server/Cargo.toml messenger/server/Cargo.lock* ./
COPY messenger/server/src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates libsqlite3-0 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/messenger-server .
COPY messenger/client ./client
EXPOSE 3000
CMD ["./messenger-server"]
