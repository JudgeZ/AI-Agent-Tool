# syntax=docker/dockerfile:1.6

FROM rust:1.83-slim-bullseye AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM gcr.io/distroless/cc-debian12:nonroot
WORKDIR /app
COPY --from=build /app/target/release/ossaat-indexer /app/indexer
EXPOSE 7070
ENV RUST_LOG=info
ENTRYPOINT ["/app/indexer"]
