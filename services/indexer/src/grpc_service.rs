use std::sync::Arc;

use serde_json::json;
use tonic::{Request, Response, Status};
use tracing::{info, instrument};

use crate::audit;
use crate::security::SecurityConfig;
use crate::storage::{Storage, StorageError};
use crate::validation;

pub mod proto {
    tonic::include_proto!("indexer");
}

use proto::{
    indexer_service_server::IndexerService, IndexDocumentRequest, IndexDocumentResponse,
    IndexSymbolsRequest, IndexSymbolsResponse, SearchDocumentsRequest, SearchDocumentsResponse,
    SearchResult, SearchSymbolsRequest, SearchSymbolsResponse,
};

pub struct IndexerServiceImpl {
    storage: Arc<Storage>,
    security_config: SecurityConfig,
}

impl IndexerServiceImpl {
    pub fn new(storage: Arc<Storage>) -> Self {
        Self {
            storage,
            security_config: SecurityConfig::from_env(),
        }
    }
}

fn validate_path(path: &str) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("path cannot be blank".to_string());
    }
    if path.len() > validation::MAX_PATH_LENGTH {
        return Err(format!(
            "path exceeds maximum length of {} characters",
            validation::MAX_PATH_LENGTH
        ));
    }
    if path.contains(['\0', '\r', '\n']) {
        return Err("path contains invalid control characters".to_string());
    }
    Ok(())
}

fn validate_content(content: &str) -> Result<(), String> {
    if content.trim().is_empty() {
        return Err("content cannot be blank".to_string());
    }
    Ok(())
}

fn validate_commit_id(commit_id: Option<&String>) -> Result<(), String> {
    if let Some(commit) = commit_id {
        if !commit.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("commit id must be hexadecimal".to_string());
        }
    }
    Ok(())
}

fn validate_query(query: &str) -> Result<(), String> {
    if query.trim().is_empty() {
        return Err("query cannot be blank".to_string());
    }
    if query.len() > validation::MAX_QUERY_LENGTH {
        return Err(format!(
            "query exceeds maximum length of {} characters",
            validation::MAX_QUERY_LENGTH
        ));
    }
    Ok(())
}

#[tonic::async_trait]
impl IndexerService for IndexerServiceImpl {
    #[instrument(skip(self, request))]
    async fn index_document(
        &self,
        request: Request<IndexDocumentRequest>,
    ) -> Result<Response<IndexDocumentResponse>, Status> {
        let req = request.into_inner();

        audit::log_audit(
            "index_document",
            "attempt",
            Some(&req.path),
            Some(json!({ "commit_id": req.commit_id })),
        );

        // Input validation
        if let Err(e) = validate_path(&req.path) {
            audit::log_audit(
                "index_document",
                "failure",
                Some(&req.path),
                Some(json!({ "error": e })),
            );
            return Err(Status::invalid_argument(e));
        }
        if let Err(e) = validate_content(&req.content) {
            audit::log_audit(
                "index_document",
                "failure",
                Some(&req.path),
                Some(json!({ "error": e })),
            );
            return Err(Status::invalid_argument(e));
        }
        if let Err(e) = validate_commit_id(req.commit_id.as_ref()) {
            audit::log_audit(
                "index_document",
                "failure",
                Some(&req.path),
                Some(json!({ "error": e })),
            );
            return Err(Status::invalid_argument(e));
        }

        // Security checks
        if let Err(e) = self.security_config.check_path(&req.path) {
            audit::log_audit(
                "index_document",
                "denied",
                Some(&req.path),
                Some(json!({ "error": e.to_string() })),
            );
            return Err(Status::permission_denied(e.to_string()));
        }

        if let Err(e) = self.security_config.scan_content(&req.content) {
            audit::log_audit(
                "index_document",
                "denied",
                Some(&req.path),
                Some(json!({ "error": e.to_string() })),
            );
            return Err(Status::permission_denied(e.to_string()));
        }

        let document_id = self
            .storage
            .index_document(req.path.clone(), req.content, req.commit_id)
            .await
            .map_err(|e: StorageError| {
                audit::log_audit(
                    "index_document",
                    "failure",
                    Some(&req.path),
                    Some(json!({ "error": e.to_string() })),
                );
                Status::from(e)
            })?;

        audit::log_audit(
            "index_document",
            "success",
            Some(&req.path),
            Some(json!({ "document_id": document_id.to_string() })),
        );
        info!(path = %req.path, "Document indexed successfully");

        Ok(Response::new(IndexDocumentResponse {
            document_id: document_id.to_string(),
            embedding_dim: crate::embeddings::EMBEDDING_DIM as i32,
        }))
    }

    #[instrument(skip(self, request))]
    async fn index_symbols(
        &self,
        request: Request<IndexSymbolsRequest>,
    ) -> Result<Response<IndexSymbolsResponse>, Status> {
        let req = request.into_inner();

        audit::log_audit(
            "index_symbols",
            "attempt",
            Some(&req.path),
            Some(json!({ "commit_id": req.commit_id, "language": req.language })),
        );

        // Input validation
        if let Err(e) = validate_path(&req.path) {
            audit::log_audit(
                "index_symbols",
                "failure",
                Some(&req.path),
                Some(json!({ "error": e })),
            );
            return Err(Status::invalid_argument(e));
        }
        if let Err(e) = validate_content(&req.content) {
            audit::log_audit(
                "index_symbols",
                "failure",
                Some(&req.path),
                Some(json!({ "error": e })),
            );
            return Err(Status::invalid_argument(e));
        }
        if let Err(e) = validate_commit_id(req.commit_id.as_ref()) {
            audit::log_audit(
                "index_symbols",
                "failure",
                Some(&req.path),
                Some(json!({ "error": e })),
            );
            return Err(Status::invalid_argument(e));
        }

        if req.language.trim().is_empty() {
            let e = Status::invalid_argument("language cannot be blank");
            audit::log_audit(
                "index_symbols",
                "failure",
                Some(&req.path),
                Some(json!({ "error": e.to_string() })),
            );
            return Err(e);
        }

        // Security checks
        if let Err(e) = self.security_config.check_path(&req.path) {
            audit::log_audit(
                "index_symbols",
                "denied",
                Some(&req.path),
                Some(json!({ "error": e.to_string() })),
            );
            return Err(Status::permission_denied(e.to_string()));
        }

        if let Err(e) = self.security_config.scan_content(&req.content) {
            audit::log_audit(
                "index_symbols",
                "denied",
                Some(&req.path),
                Some(json!({ "error": e.to_string() })),
            );
            return Err(Status::permission_denied(e.to_string()));
        }

        let symbol_count = self
            .storage
            .index_symbols(req.path.clone(), req.content, req.language, req.commit_id)
            .await
            .map_err(|e: StorageError| {
                audit::log_audit(
                    "index_symbols",
                    "failure",
                    Some(&req.path),
                    Some(json!({ "error": e.to_string() })),
                );
                Status::from(e)
            })?;

        audit::log_audit(
            "index_symbols",
            "success",
            Some(&req.path),
            Some(json!({ "symbol_count": symbol_count })),
        );
        info!(path = %req.path, count = symbol_count, "Symbols indexed successfully");

        Ok(Response::new(IndexSymbolsResponse {
            symbol_count: symbol_count as i32,
        }))
    }

    #[instrument(skip(self, request))]
    async fn search_documents(
        &self,
        request: Request<SearchDocumentsRequest>,
    ) -> Result<Response<SearchDocumentsResponse>, Status> {
        let req = request.into_inner();

        audit::log_audit(
            "search_documents",
            "attempt",
            None,
            Some(json!({
                "query": req.query,
                "path_prefix": req.path_prefix,
                "commit_id": req.commit_id
            })),
        );

        // Input validation
        if let Err(e) = validate_query(&req.query) {
            audit::log_audit(
                "search_documents",
                "failure",
                None,
                Some(json!({ "error": e })),
            );
            return Err(Status::invalid_argument(e));
        }

        if let Some(ref prefix) = req.path_prefix {
            if let Err(e) = validate_path(prefix) {
                audit::log_audit(
                    "search_documents",
                    "failure",
                    None,
                    Some(json!({ "error": e })),
                );
                return Err(Status::invalid_argument(e));
            }
            // Security check for path prefix
            if let Err(e) = self.security_config.check_path(prefix) {
                audit::log_audit(
                    "search_documents",
                    "denied",
                    None,
                    Some(json!({ "error": e.to_string() })),
                );
                return Err(Status::permission_denied(e.to_string()));
            }
        }

        if let Err(e) = validate_commit_id(req.commit_id.as_ref()) {
            audit::log_audit(
                "search_documents",
                "failure",
                None,
                Some(json!({ "error": e })),
            );
            return Err(Status::invalid_argument(e));
        }

        let top_k = if req.top_k <= 0 {
            5
        } else if req.top_k > 100 {
            100
        } else {
            req.top_k as usize
        };

        let documents = self
            .storage
            .search_documents(req.query, top_k, req.path_prefix, req.commit_id)
            .await
            .map_err(|e: StorageError| {
                audit::log_audit(
                    "search_documents",
                    "failure",
                    None,
                    Some(json!({ "error": e.to_string() })),
                );
                Status::from(e)
            })?;

        let results: Vec<SearchResult> = documents
            .into_iter()
            .map(|(doc, score)| SearchResult {
                id: doc.id.to_string(),
                path: doc.path,
                score,
                snippet: if doc.content.len() > 160 {
                    format!("{}…", doc.content.chars().take(157).collect::<String>())
                } else {
                    doc.content
                },
                commit_id: doc.commit_id,
            })
            .collect();

        audit::log_audit(
            "search_documents",
            "success",
            None,
            Some(json!({ "result_count": results.len() })),
        );
        info!(count = results.len(), "Document search completed");

        Ok(Response::new(SearchDocumentsResponse { results }))
    }

    #[instrument(skip(self, request))]
    async fn search_symbols(
        &self,
        request: Request<SearchSymbolsRequest>,
    ) -> Result<Response<SearchSymbolsResponse>, Status> {
        let req = request.into_inner();

        audit::log_audit(
            "search_symbols",
            "attempt",
            None,
            Some(json!({
                "query": req.query,
                "path_prefix": req.path_prefix,
                "commit_id": req.commit_id
            })),
        );

        // Input validation
        if let Err(e) = validate_query(&req.query) {
            audit::log_audit(
                "search_symbols",
                "failure",
                None,
                Some(json!({ "error": e })),
            );
            return Err(Status::invalid_argument(e));
        }

        if let Some(ref prefix) = req.path_prefix {
            if let Err(e) = validate_path(prefix) {
                audit::log_audit(
                    "search_symbols",
                    "failure",
                    None,
                    Some(json!({ "error": e })),
                );
                return Err(Status::invalid_argument(e));
            }
            // Security check for path prefix
            if let Err(e) = self.security_config.check_path(prefix) {
                audit::log_audit(
                    "search_symbols",
                    "denied",
                    None,
                    Some(json!({ "error": e.to_string() })),
                );
                return Err(Status::permission_denied(e.to_string()));
            }
        }

        if let Err(e) = validate_commit_id(req.commit_id.as_ref()) {
            audit::log_audit(
                "search_symbols",
                "failure",
                None,
                Some(json!({ "error": e })),
            );
            return Err(Status::invalid_argument(e));
        }

        let top_k = if req.top_k <= 0 {
            5
        } else if req.top_k > 100 {
            100
        } else {
            req.top_k as usize
        };

        let symbols = self
            .storage
            .search_symbols(req.query, top_k, req.path_prefix, req.commit_id)
            .await
            .map_err(|e: StorageError| {
                audit::log_audit(
                    "search_symbols",
                    "failure",
                    None,
                    Some(json!({ "error": e.to_string() })),
                );
                Status::from(e)
            })?;

        let results: Vec<SearchResult> = symbols
            .into_iter()
            .map(|(symbol, score)| SearchResult {
                id: symbol.id.to_string(),
                path: symbol.path,
                score,
                snippet: if symbol.content.len() > 160 {
                    format!("{}…", symbol.content.chars().take(157).collect::<String>())
                } else {
                    symbol.content
                },
                commit_id: symbol.commit_id,
            })
            .collect();

        audit::log_audit(
            "search_symbols",
            "success",
            None,
            Some(json!({ "result_count": results.len() })),
        );
        info!(count = results.len(), "Symbol search completed");

        Ok(Response::new(SearchSymbolsResponse { results }))
    }
}
