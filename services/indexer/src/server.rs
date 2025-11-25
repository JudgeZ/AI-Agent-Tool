use std::net::{AddrParseError, SocketAddr};
use std::sync::Arc;

use axum::{routing::get, Json, Router};
use serde_json::{json, Value};
use thiserror::Error;
use tonic::transport::Server;
use tracing::{info, warn};

use crate::grpc_service::{
    proto::indexer_service_server::IndexerServiceServer, IndexerServiceImpl,
};
use crate::storage::{create_storage, StorageConfig};
use crate::telemetry;
use crate::temporal::{TemporalConfig, TemporalIndex};

/// Guard that ensures tracing is shut down when dropped.
/// This guarantees pending traces are flushed even on early returns.
struct TracingGuard;

impl Drop for TracingGuard {
    fn drop(&mut self) {
        telemetry::shutdown_tracing();
    }
}

const DEFAULT_LISTEN_ADDR: &str = "0.0.0.0:9200";
const LISTEN_ADDR_ENV: &str = "INDEXER_LISTEN_ADDR";
const DEFAULT_GRPC_ADDR: &str = "0.0.0.0:9201";
const GRPC_ADDR_ENV: &str = "INDEXER_GRPC_ADDR";

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
    #[error("storage error: {0}")]
    Storage(String),
    #[error("temporal index error: {0}")]
    Temporal(#[from] crate::temporal::TemporalError),
    #[error("gRPC server error: {0}")]
    GrpcServer(#[from] tonic::transport::Error),
}

pub async fn run() -> Result<(), IndexerError> {
    telemetry::init_tracing()?;

    // Guard ensures shutdown_tracing() is called on all exit paths (including early returns)
    let _tracing_guard = TracingGuard;

    let http_addr = resolve_listen_addr()?;
    let grpc_addr = resolve_grpc_addr()?;

    // Initialize storage
    let storage_config =
        StorageConfig::from_env().map_err(|e| IndexerError::Storage(e.to_string()))?;
    let storage = create_storage(storage_config)
        .await
        .map_err(|e| IndexerError::Storage(e.to_string()))?;

    info!("Storage initialized successfully");

    // Initialize temporal index
    let temporal_config = TemporalConfig::from_env();
    let temporal_index = Arc::new(TemporalIndex::new(temporal_config, storage.clone())?);

    info!("Temporal index initialized successfully");

    // Create gRPC service
    let grpc_service = IndexerServiceImpl::new(storage.clone(), temporal_index);
    let grpc_server = IndexerServiceServer::new(grpc_service);

    // Create HTTP service (legacy support / health check)
    let app = Router::new().route("/healthz", get(health_check));

    // Spawn HTTP server
    let http_handle = {
        let listener = tokio::net::TcpListener::bind(http_addr).await?;
        info!("HTTP server listening on {http_addr}");

        tokio::spawn(async move {
            axum::serve(listener, app.into_make_service())
                .with_graceful_shutdown(shutdown_signal())
                .await
        })
    };

    // Spawn gRPC server
    let grpc_handle = {
        info!("gRPC server listening on {grpc_addr}");

        tokio::spawn(async move {
            Server::builder()
                .add_service(grpc_server)
                .serve_with_shutdown(grpc_addr, shutdown_signal())
                .await
        })
    };

    // Wait for both servers
    let (http_result, grpc_result) = tokio::join!(http_handle, grpc_handle);

    // Check for errors
    if let Err(e) = http_result {
        warn!("HTTP server task failed: {}", e);
    }

    if let Err(e) = grpc_result {
        warn!("gRPC server task failed: {}", e);
    }

    // TracingGuard Drop handles shutdown_tracing()
    Ok(())
}

fn resolve_listen_addr() -> Result<SocketAddr, IndexerError> {
    let raw = std::env::var(LISTEN_ADDR_ENV).unwrap_or_else(|_| DEFAULT_LISTEN_ADDR.to_string());
    raw.parse()
        .map_err(|error| IndexerError::InvalidListenAddr(raw, error))
}

fn resolve_grpc_addr() -> Result<SocketAddr, IndexerError> {
    let raw = std::env::var(GRPC_ADDR_ENV).unwrap_or_else(|_| DEFAULT_GRPC_ADDR.to_string());
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
            let addr = match resolve_listen_addr() {
                Ok(addr) => addr,
                Err(error) => panic!("expected default address to resolve, got {error}"),
            };
            let expected = DEFAULT_LISTEN_ADDR
                .parse()
                .unwrap_or_else(|error| panic!("invalid default listen address: {error}"));
            assert_eq!(addr, expected);
        });
    }

    #[tokio::test]
    async fn rejects_invalid_addr() {
        with_env_var(Some("not-an-addr"), || {
            let err = match resolve_listen_addr() {
                Ok(_) => panic!("expected invalid listen addr to fail"),
                Err(err) => err,
            };
            assert!(matches!(err, IndexerError::InvalidListenAddr(_, _)));
        });
    }
}
