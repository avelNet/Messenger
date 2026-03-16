FROM rust:latest as builder
RUN apt-get update && apt-get install -y pkg-config libssl-dev libsqlite3-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY messenger/server/Cargo.toml messenger/server/Cargo.lock* ./
COPY messenger/server/src ./src
RUN cargo build --release

FROM rust:latest
RUN apt-get update && apt-get install -y ca-certificates libsqlite3-0 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/messenger-server .
COPY messenger/client ./client
EXPOSE 3000
CMD ["./messenger-server"]
