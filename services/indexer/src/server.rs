use std::net::{AddrParseError, SocketAddr};

use axum::{routing::get, Json, Router};
use serde_json::{json, Value};
use thiserror::Error;
use tracing::{info, warn};

use crate::semantic::SemanticStore;
use crate::telemetry;

const DEFAULT_LISTEN_ADDR: &str = "0.0.0.0:9200";
const LISTEN_ADDR_ENV: &str = "INDEXER_LISTEN_ADDR";

#[derive(Debug, Error)]
pub enum IndexerError {
    #[error("telemetry initialization failed: {0}")]
    Telemetry(#[from] telemetry::TelemetryError),
    #[error("invalid listen address '{0}': {1}")]
    InvalidListenAddr(String, AddrParseError),
    #[error("failed to bind listener: {0}")]
    Bind(#[from] std::io::Error),
    #[error("server error: {0}")]
    Server(#[from] hyper::Error),
}

pub async fn run() -> Result<(), IndexerError> {
    telemetry::init_tracing()?;

    let addr = resolve_listen_addr()?;
    let store = SemanticStore::new();

    let app = Router::new()
        .route("/healthz", get(health_check))
        .with_state(store);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!("indexer listening on {addr}");

    axum::serve(listener, app.into_make_service())
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

fn resolve_listen_addr() -> Result<SocketAddr, IndexerError> {
    let raw = std::env::var(LISTEN_ADDR_ENV).unwrap_or_else(|_| DEFAULT_LISTEN_ADDR.to_string());
    raw.parse()
        .map_err(|error| IndexerError::InvalidListenAddr(raw, error))
}

async fn health_check() -> Json<Value> {
    Json(json!({
        "status": "ok"
    }))
}

async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        warn!("failed to listen for shutdown signal: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_env_var<T, F: FnOnce() -> T>(value: Option<&str>, f: F) -> T {
        let previous = std::env::var(LISTEN_ADDR_ENV).ok();
        match value {
            Some(val) => std::env::set_var(LISTEN_ADDR_ENV, val),
            None => std::env::remove_var(LISTEN_ADDR_ENV),
        }
        let result = f();
        match previous {
            Some(val) => std::env::set_var(LISTEN_ADDR_ENV, val),
            None => std::env::remove_var(LISTEN_ADDR_ENV),
        }
        result
    }

    #[tokio::test]
    async fn resolves_default_addr() {
        with_env_var(None, || {
            let addr = resolve_listen_addr().expect("should default");
            assert_eq!(addr, DEFAULT_LISTEN_ADDR.parse().unwrap());
        });
    }

    #[tokio::test]
    async fn rejects_invalid_addr() {
        with_env_var(Some("not-an-addr"), || {
            let err = resolve_listen_addr().unwrap_err();
            assert!(matches!(err, IndexerError::InvalidListenAddr(_, _)));
        });
    }
}
