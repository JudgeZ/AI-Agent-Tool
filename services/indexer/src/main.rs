use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::net::SocketAddr;
use thiserror::Error;
use tokio::net::TcpListener;
use tracing::{error, info};

mod audit;
mod ast;
mod lsp;
mod security;
mod semantic;

use audit::log_audit;

const MAX_PATH_LENGTH: usize = 1024;
const MAX_QUERY_LENGTH: usize = 4096;
const MAX_LANGUAGE_LENGTH: usize = 64;
const MAX_COMMIT_ID_LENGTH: usize = 128;
const MAX_TOP_K: usize = 100;

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

fn validation_error(message: &str) -> (StatusCode, Json<ErrorResponse>) {
    (
        StatusCode::BAD_REQUEST,
        Json(ErrorResponse {
            error: message.to_string(),
        }),
    )
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
    Json(request): Json<AstRequest>,
) -> Result<Json<ast::AstResponse>, (StatusCode, Json<ErrorResponse>)> {
    let language = request.language.trim();
    if language.is_empty() {
        return Err(validation_error("language is required"));
    }
    if language.len() > MAX_LANGUAGE_LENGTH {
        return Err(validation_error("language is too long"));
    }

    let source = request.source.trim();
    if source.is_empty() {
        return Err(validation_error("source is required"));
    }

    let mut options = ast::AstOptions::default();
    if let Some(max_depth) = request.max_depth {
        options.max_depth = max_depth.max(1);
    }
    if let Some(max_nodes) = request.max_nodes {
        options.max_nodes = max_nodes.max(1);
    }
    if let Some(include_snippet) = request.include_snippet {
        options.include_snippet = include_snippet;
    }

    match ast::build_ast(language, source, options) {
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
    Json(mut request): Json<semantic::AddDocumentRequest>,
) -> Result<Json<semantic::AddDocumentResponse>, (StatusCode, Json<ErrorResponse>)> {
    request.path = request.path.trim().to_string();
    if request.path.is_empty() {
        return Err(validation_error("path is required"));
    }
    if request.path.len() > MAX_PATH_LENGTH {
        return Err(validation_error("path is too long"));
    }

    if request.content.trim().is_empty() {
        return Err(validation_error("content is required"));
    }

    if let Some(commit_id) = request.commit_id.as_mut() {
        let trimmed = commit_id.trim();
        if trimmed.is_empty() {
            request.commit_id = None;
        } else if trimmed.len() > MAX_COMMIT_ID_LENGTH {
            return Err(validation_error("commit_id is too long"));
        } else {
            *commit_id = trimmed.to_string();
        }
    }

    if let Err(error) = state.security.check_path(&request.path) {
        log_audit(
            "semantic.document.add",
            "denied",
            Some("semantic.document"),
            Some(json!({
                "reason": error.to_string(),
                "path": request.path,
            })),
        );
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: error.to_string(),
            }),
        ));
    }
    if let Err(error) = state.security.scan_content(&request.content) {
        log_audit(
            "semantic.document.add",
            "denied",
            Some("semantic.document"),
            Some(json!({
                "reason": error.to_string(),
                "path": request.path,
            })),
        );
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(ErrorResponse {
                error: error.to_string(),
            }),
        ));
    }

    let path = request.path.clone();
    let response = state.semantic.add_document(request);
    log_audit(
        "semantic.document.add",
        "success",
        Some("semantic.document"),
        Some(json!({
            "path": path,
            "document_id": response.document_id,
        })),
    );
    Ok(Json(response))
}

async fn search_semantic(
    State(state): State<AppState>,
    Json(mut request): Json<semantic::SearchRequest>,
) -> Result<Json<Vec<semantic::SearchResult>>, (StatusCode, Json<ErrorResponse>)> {
    request.query = request.query.trim().to_string();
    if request.query.is_empty() {
        return Err(validation_error("query is required"));
    }
    if request.query.len() > MAX_QUERY_LENGTH {
        return Err(validation_error("query is too long"));
    }

    request.top_k = request.top_k.clamp(1, MAX_TOP_K);

    if let Some(prefix) = request.path_prefix.as_mut() {
        let trimmed = prefix.trim();
        if trimmed.is_empty() {
            request.path_prefix = None;
        } else if trimmed.len() > MAX_PATH_LENGTH {
            return Err(validation_error("path_prefix is too long"));
        } else {
            *prefix = trimmed.to_string();
        }
    }

    if let Some(commit_id) = request.commit_id.as_mut() {
        let trimmed = commit_id.trim();
        if trimmed.is_empty() {
            request.commit_id = None;
        } else if trimmed.len() > MAX_COMMIT_ID_LENGTH {
            return Err(validation_error("commit_id is too long"));
        } else {
            *commit_id = trimmed.to_string();
        }
    }

    let mut results = state.semantic.search(request);
    results.retain(|entry| state.security.is_allowed(&entry.path));
    Ok(Json(results))
}

async fn semantic_history(
    State(state): State<AppState>,
    Path(path): Path<String>,
) -> Result<Json<Vec<semantic::HistoryEntry>>, (StatusCode, Json<ErrorResponse>)> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(validation_error("path is required"));
    }
    if trimmed.len() > MAX_PATH_LENGTH {
        return Err(validation_error("path is too long"));
    }

    let normalized_path = trimmed.to_string();

    if let Err(error) = state.security.check_path(&normalized_path) {
        log_audit(
            "semantic.history",
            "denied",
            Some("semantic.history"),
            Some(json!({
                "reason": error.to_string(),
                "path": normalized_path,
            })),
        );
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: error.to_string(),
            }),
        ));
    }
    let history = state.semantic.history_for_path(&normalized_path);
    log_audit(
        "semantic.history",
        "success",
        Some("semantic.history"),
        Some(json!({
            "path": normalized_path,
            "entries": history.len(),
        })),
    );
    Ok(Json(history))
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

    #[tokio::test]
    async fn ast_handler_rejects_blank_language() {
        let result = ast_handler(Json(AstRequest {
            language: "   ".into(),
            source: "fn main() {}".into(),
            max_depth: None,
            max_nodes: None,
            include_snippet: None,
        }))
        .await;

        let (status, Json(body)) = result.unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body.error, "language is required");
    }

    #[tokio::test]
    async fn add_document_rejects_blank_path() {
        let security = security::SecurityConfig::with_rules(vec!["/".into()], Vec::new());
        let state = AppState::new(security);
        let app = Router::new()
            .route("/semantic/documents", axum_post(add_semantic_document))
            .with_state(state);

        let payload = serde_json::json!({
            "path": "   ",
            "content": "hello",
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

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn search_rejects_blank_query() {
        let security = security::SecurityConfig::with_rules(vec!["/".into()], Vec::new());
        let state = AppState::new(security);
        let app = Router::new()
            .route("/semantic/search", axum_post(search_semantic))
            .with_state(state);

        let payload = serde_json::json!({
            "query": "   ",
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/semantic/search")
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn history_rejects_blank_path() {
        let security = security::SecurityConfig::with_rules(vec!["/".into()], Vec::new());
        let state = AppState::new(security);
        let app = Router::new()
            .route("/semantic/history/*path", get(semantic_history))
            .with_state(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/semantic/history/%20")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
