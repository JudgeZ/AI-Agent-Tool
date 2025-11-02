use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use thiserror::Error;
use tokio::net::TcpListener;
use tracing::{error, info};

mod ast;
mod lsp;
mod security;
mod semantic;

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
}

#[derive(Debug, Error)]
enum IndexerError {
    #[error("bind error: {0}")]
    Bind(#[source] std::io::Error),
    #[error("signal handling error: {0}")]
    Signal(#[source] std::io::Error),
    #[error("server error: {0}")]
    Server(#[source] std::io::Error),
}

#[derive(Debug, Deserialize)]
struct AstRequest {
    language: String,
    source: String,
    #[serde(default)]
    max_depth: Option<usize>,
    #[serde(default)]
    max_nodes: Option<usize>,
    #[serde(default)]
    include_snippet: Option<bool>,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Clone)]
struct AppState {
    semantic: semantic::SemanticStore,
    security: security::SecurityConfig,
}

impl AppState {
    fn new(security: security::SecurityConfig) -> Self {
        Self {
            semantic: semantic::SemanticStore::new(),
            security,
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new(security::SecurityConfig::from_env())
    }
}

async fn healthcheck() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn ast_handler(
    req: Json<AstRequest>,
) -> Result<Json<ast::AstResponse>, (StatusCode, Json<ErrorResponse>)> {
    let mut options = ast::AstOptions::default();
    if let Some(max_depth) = req.max_depth {
        options.max_depth = max_depth.max(1);
    }
    if let Some(max_nodes) = req.max_nodes {
        options.max_nodes = max_nodes.max(1);
    }
    if let Some(include_snippet) = req.include_snippet {
        options.include_snippet = include_snippet;
    }

    match ast::build_ast(&req.language, &req.source, options) {
        Ok(ast) => Ok(Json(ast)),
        Err(ast::AstError::UnsupportedLanguage(lang)) => Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: format!("unsupported language: {lang}"),
            }),
        )),
        Err(err) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: err.to_string(),
            }),
        )),
    }
}

async fn add_semantic_document(
    State(state): State<AppState>,
    Json(request): Json<semantic::AddDocumentRequest>,
) -> Result<Json<semantic::AddDocumentResponse>, (StatusCode, Json<ErrorResponse>)> {
    state.security.check_path(&request.path).map_err(|error| {
        (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: error.to_string(),
            }),
        )
    })?;
    state
        .security
        .scan_content(&request.content)
        .map_err(|error| {
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(ErrorResponse {
                    error: error.to_string(),
                }),
            )
        })?;
    Ok(Json(state.semantic.add_document(request)))
}

async fn search_semantic(
    State(state): State<AppState>,
    Json(request): Json<semantic::SearchRequest>,
) -> Json<Vec<semantic::SearchResult>> {
    let mut results = state.semantic.search(request);
    results.retain(|entry| state.security.is_allowed(&entry.path));
    Json(results)
}

async fn semantic_history(
    State(state): State<AppState>,
    Path(path): Path<String>,
) -> Result<Json<Vec<semantic::HistoryEntry>>, (StatusCode, Json<ErrorResponse>)> {
    state.security.check_path(&path).map_err(|error| {
        (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: error.to_string(),
            }),
        )
    })?;
    Ok(Json(state.semantic.history_for_path(&path)))
}

async fn run() -> Result<(), IndexerError> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .without_time()
        .init();

    let state = AppState::default();

    let app = Router::new()
        .route("/healthz", get(healthcheck))
        .route("/ast", post(ast_handler))
        .route("/semantic/documents", post(add_semantic_document))
        .route("/semantic/search", post(search_semantic))
        .route("/semantic/history/*path", get(semantic_history))
        .with_state(state.clone());

    let addr: SocketAddr = ([0, 0, 0, 0], 7070).into();
    let listener = TcpListener::bind(addr).await.map_err(IndexerError::Bind)?;
    let bound_addr = listener.local_addr().map_err(IndexerError::Bind)?;
    info!(%bound_addr, "starting indexer");

    let lsp_addr = std::env::var("INDEXER_LSP_ADDR").ok();
    let lsp_handle = lsp::spawn_lsp_listener(lsp_addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            if let Err(err) = shutdown_signal().await {
                error!(%err, "shutdown signal error");
            }
        })
        .await
        .map_err(IndexerError::Server)?;

    info!("indexer stopped");
    lsp_handle.abort();
    let _ = lsp_handle.await;
    Ok(())
}

async fn shutdown_signal() -> Result<(), IndexerError> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};

        let mut terminate = signal(SignalKind::terminate()).map_err(IndexerError::Signal)?;
        tokio::select! {
            res = tokio::signal::ctrl_c() => res.map_err(IndexerError::Signal)?,
            _ = terminate.recv() => {}
        }
    }

    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c()
            .await
            .map_err(IndexerError::Signal)?;
    }

    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), IndexerError> {
    run().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request, routing::post as axum_post, Router};
    use regex::Regex;
    use tower::util::ServiceExt;

    #[tokio::test]
    async fn healthcheck_returns_ok() {
        let Json(resp) = healthcheck().await;
        assert_eq!(resp.status, "ok");
    }

    #[tokio::test]
    async fn add_document_enforces_acl() {
        let security = security::SecurityConfig::with_rules(vec!["src/".into()], Vec::new());
        let state = AppState::new(security);
        let app = Router::new()
            .route("/semantic/documents", axum_post(add_semantic_document))
            .with_state(state);

        let payload = serde_json::json!({
            "path": "docs/readme.md",
            "content": "hello",
            "commit_id": "abc"
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/semantic/documents")
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn add_document_blocks_dlp_patterns() {
        let security = security::SecurityConfig::with_rules(
            vec!["/".into()],
            vec![Regex::new("SECRET_TOKEN").unwrap()],
        );
        let state = AppState::new(security);
        let app = Router::new()
            .route("/semantic/documents", axum_post(add_semantic_document))
            .with_state(state);

        let payload = serde_json::json!({
            "path": "src/lib.rs",
            "content": "let SECRET_TOKEN = \"xyz\";",
            "commit_id": "abc"
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/semantic/documents")
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }
}
