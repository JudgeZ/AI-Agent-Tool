# syntax=docker/dockerfile:1.6

FROM rust:latest AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev protobuf-compiler && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock build.rs ./
COPY proto ./proto
COPY src ./src
RUN cargo build --release

FROM debian:trixie-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libssl3 zlib1g ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/ossaat-indexer /app/indexer
EXPOSE 7070
ENV RUST_LOG=info
ENTRYPOINT ["/app/indexer"]
