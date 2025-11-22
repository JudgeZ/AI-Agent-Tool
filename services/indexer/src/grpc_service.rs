use std::sync::Arc;

use serde_json::json;
use tonic::{Request, Response, Status};
use tracing::{info, instrument};

use crate::analysis;
use crate::ast;
use crate::audit;
use crate::security::SecurityConfig;
use crate::storage::{IndexStorage, StorageError};
use crate::temporal::TemporalIndex;
use crate::validation;

pub mod proto {
    tonic::include_proto!("indexer");
}

use proto::{
    indexer_service_server::IndexerService, CorrelateFailureRequest, CorrelateFailureResponse,
    GetDefinitionsRequest, GetDefinitionsResponse, GetReferencesRequest, GetReferencesResponse,
    GetSymbolAtCommitRequest, GetSymbolAtCommitResponse, GetSymbolGraphRequest,
    GetSymbolGraphResponse, GetSymbolHistoryRequest, GetSymbolHistoryResponse, GraphEdge,
    GraphNode, IndexDocumentRequest, IndexDocumentResponse, IndexSymbolsRequest,
    IndexSymbolsResponse, Location, Position, Range, SearchDocumentsRequest,
    SearchDocumentsResponse, SearchResult, SearchSymbolsRequest, SearchSymbolsResponse,
    SuspectChange, Symbol, SymbolVersion,
};

pub struct IndexerServiceImpl {
    storage: Arc<dyn IndexStorage>,
    temporal: Arc<TemporalIndex>,
    security_config: SecurityConfig,
}

impl IndexerServiceImpl {
    pub fn new(storage: Arc<dyn IndexStorage>, temporal: Arc<TemporalIndex>) -> Self {
        Self {
            storage,
            temporal,
            security_config: SecurityConfig::from_env(),
        }
    }

    async fn get_file_content(
        &self,
        path: &str,
        commit_id: Option<&str>,
    ) -> Result<String, Status> {
        // If commit_id is provided, use temporal index
        if let Some(commit) = commit_id {
            let symbol = self
                .temporal
                .get_symbol_at_commit(path, commit)
                .await
                .map_err(|e| Status::internal(e.to_string()))?;

            return match symbol {
                Some(s) => Ok(s.content),
                None => Err(Status::not_found(format!(
                    "File not found at commit {}",
                    commit
                ))),
            };
        }

        // Check ACL before returning any content
        if let Err(e) = self.security_config.check_path(path) {
            return Err(Status::permission_denied(e.to_string()));
        }

        Err(Status::unimplemented(
            "Must provide commit_id for code navigation currently",
        ))
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

    #[instrument(skip(self, request))]
    async fn get_symbol_graph(
        &self,
        request: Request<GetSymbolGraphRequest>,
    ) -> Result<Response<GetSymbolGraphResponse>, Status> {
        let req = request.into_inner();

        // Validate path and check ACL
        if let Err(e) = validate_path(&req.path) {
            return Err(Status::invalid_argument(e));
        }

        // Note: get_file_content handles ACL check internally
        let content = self
            .get_file_content(&req.path, req.commit_id.as_deref())
            .await?;

        // Determine language from path
        let language = if req.path.ends_with(".rs") {
            "rust"
        } else if req.path.ends_with(".ts") || req.path.ends_with(".tsx") {
            "typescript"
        } else if req.path.ends_with(".js") || req.path.ends_with(".jsx") {
            "javascript"
        } else {
            return Err(Status::invalid_argument("Unsupported language"));
        };

        let (tree, _) = ast::parse_tree(language, &content)
            .map_err(|e| Status::internal(format!("Failed to parse AST: {}", e)))?;

        let (nodes, edges) = analysis::analyze_graph(&tree, &content, &req.path);

        Ok(Response::new(GetSymbolGraphResponse {
            nodes: nodes
                .into_iter()
                .map(|n| GraphNode {
                    id: n.id,
                    name: n.name,
                    kind: n.kind,
                    path: req.path.clone(),
                })
                .collect(),
            edges: edges
                .into_iter()
                .map(|e| GraphEdge {
                    from_id: e.from_id,
                    to_id: e.to_id,
                    relation: e.relation,
                })
                .collect(),
        }))
    }

    #[instrument(skip(self, request))]
    async fn get_references(
        &self,
        request: Request<GetReferencesRequest>,
    ) -> Result<Response<GetReferencesResponse>, Status> {
        let req = request.into_inner();

        // Validate path
        if let Err(e) = validate_path(&req.path) {
            return Err(Status::invalid_argument(e));
        }

        let content = self
            .get_file_content(&req.path, req.commit_id.as_deref())
            .await?;

        let language = if req.path.ends_with(".rs") {
            "rust"
        } else if req.path.ends_with(".ts") || req.path.ends_with(".tsx") {
            "typescript"
        } else if req.path.ends_with(".js") || req.path.ends_with(".jsx") {
            "javascript"
        } else {
            return Err(Status::invalid_argument("Unsupported language"));
        };

        let (tree, _) = ast::parse_tree(language, &content)
            .map_err(|e| Status::internal(format!("Failed to parse AST: {}", e)))?;

        let position = ast::Position {
            line: req.line,
            column: req.character,
        };

        let (name, _) = analysis::identifier_at_position(&tree, &content, position)
            .ok_or_else(|| Status::not_found("No identifier at position"))?;

        let mut locations = Vec::new();

        if req.include_declaration {
            if let Some(range) = analysis::find_declaration(&tree, &content, &name) {
                locations.push(Location {
                    path: req.path.clone(),
                    range: Some(Range {
                        start: Some(Position {
                            line: range.start.line,
                            character: range.start.column,
                        }),
                        end: Some(Position {
                            line: range.end.line,
                            character: range.end.column,
                        }),
                    }),
                });
            }
        }

        let refs = analysis::find_references(&tree, &content, &name);
        for r in refs {
            locations.push(Location {
                path: req.path.clone(),
                range: Some(Range {
                    start: Some(Position {
                        line: r.start.line,
                        character: r.start.column,
                    }),
                    end: Some(Position {
                        line: r.end.line,
                        character: r.end.column,
                    }),
                }),
            });
        }

        Ok(Response::new(GetReferencesResponse { locations }))
    }

    #[instrument(skip(self, request))]
    async fn get_definitions(
        &self,
        request: Request<GetDefinitionsRequest>,
    ) -> Result<Response<GetDefinitionsResponse>, Status> {
        let req = request.into_inner();

        // Validate path
        if let Err(e) = validate_path(&req.path) {
            return Err(Status::invalid_argument(e));
        }

        let content = self
            .get_file_content(&req.path, req.commit_id.as_deref())
            .await?;

        let language = if req.path.ends_with(".rs") {
            "rust"
        } else if req.path.ends_with(".ts") || req.path.ends_with(".tsx") {
            "typescript"
        } else if req.path.ends_with(".js") || req.path.ends_with(".jsx") {
            "javascript"
        } else {
            return Err(Status::invalid_argument("Unsupported language"));
        };

        let (tree, _) = ast::parse_tree(language, &content)
            .map_err(|e| Status::internal(format!("Failed to parse AST: {}", e)))?;

        let position = ast::Position {
            line: req.line,
            column: req.character,
        };

        let (name, _) = analysis::identifier_at_position(&tree, &content, position)
            .ok_or_else(|| Status::not_found("No identifier at position"))?;

        let mut locations = Vec::new();

        if let Some(range) = analysis::find_declaration(&tree, &content, &name) {
            locations.push(Location {
                path: req.path.clone(),
                range: Some(Range {
                    start: Some(Position {
                        line: range.start.line,
                        character: range.start.column,
                    }),
                    end: Some(Position {
                        line: range.end.line,
                        character: range.end.column,
                    }),
                }),
            });
        }

        Ok(Response::new(GetDefinitionsResponse { locations }))
    }

    #[instrument(skip(self, request))]
    async fn get_symbol_history(
        &self,
        request: Request<GetSymbolHistoryRequest>,
    ) -> Result<Response<GetSymbolHistoryResponse>, Status> {
        let req = request.into_inner();

        // Validate path
        if let Err(e) = validate_path(&req.path) {
            return Err(Status::invalid_argument(e));
        }

        // Security check
        if let Err(e) = self.security_config.check_path(&req.path) {
            return Err(Status::permission_denied(e.to_string()));
        }

        let history = self.temporal.get_symbol_history(&req.path);

        let versions = history
            .into_iter()
            .map(|v| SymbolVersion {
                symbol_id: v.symbol_id.to_string(),
                commit_id: v.commit_id,
                timestamp: v.timestamp.to_rfc3339(),
                change_type: format!("{:?}", v.change_type),
                author: v.author,
                commit_message: v.commit_message,
                previous_path: v.previous_path,
            })
            .collect();

        Ok(Response::new(GetSymbolHistoryResponse { versions }))
    }

    #[instrument(skip(self, request))]
    async fn get_symbol_at_commit(
        &self,
        request: Request<GetSymbolAtCommitRequest>,
    ) -> Result<Response<GetSymbolAtCommitResponse>, Status> {
        let req = request.into_inner();

        // Validate path
        if let Err(e) = validate_path(&req.path) {
            return Err(Status::invalid_argument(e));
        }

        if let Err(e) = validate_commit_id(Some(&req.commit_id)) {
            return Err(Status::invalid_argument(e));
        }

        // Security check
        if let Err(e) = self.security_config.check_path(&req.path) {
            return Err(Status::permission_denied(e.to_string()));
        }

        let symbol = self
            .temporal
            .get_symbol_at_commit(&req.path, &req.commit_id)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        let symbol_proto = symbol.map(|s| Symbol {
            id: s.id.to_string(),
            path: s.path,
            name: s.name,
            kind: s.kind,
            content: s.content,
            commit_id: s.commit_id.unwrap_or_default(),
            start_line: s.start_line,
            end_line: s.end_line,
            language: s
                .metadata
                .as_ref()
                .and_then(|m| m.get("language"))
                .and_then(|l| l.as_str())
                .unwrap_or("unknown")
                .to_string(),
        });

        Ok(Response::new(GetSymbolAtCommitResponse {
            symbol: symbol_proto,
        }))
    }

    #[instrument(skip(self, request))]
    async fn correlate_failure(
        &self,
        request: Request<CorrelateFailureRequest>,
    ) -> Result<Response<CorrelateFailureResponse>, Status> {
        let req = request.into_inner();

        if let Err(e) = validate_commit_id(Some(&req.commit_id)) {
            return Err(Status::invalid_argument(e));
        }
        if let Err(e) = validate_commit_id(req.previous_commit_id.as_ref()) {
            return Err(Status::invalid_argument(e));
        }

        let suspects = self
            .temporal
            .correlate_ci_failure(
                &req.test_name,
                &req.failure_message,
                &req.commit_id,
                req.previous_commit_id.as_deref(),
            )
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        let suspects_proto = suspects
            .into_iter()
            .map(|s| SuspectChange {
                symbol: Some(Symbol {
                    id: s.symbol.id.to_string(),
                    path: s.symbol.path,
                    name: s.symbol.name,
                    kind: s.symbol.kind,
                    content: s.symbol.content,
                    commit_id: s.symbol.commit_id.unwrap_or_default(),
                    start_line: s.symbol.start_line,
                    end_line: s.symbol.end_line,
                    language: "unknown".to_string(), // Simplified
                }),
                relevance_score: s.relevance_score,
                reason: s.reason,
                change_type: format!("{:?}", s.change_type),
            })
            .collect();

        Ok(Response::new(CorrelateFailureResponse {
            suspects: suspects_proto,
        }))
    }
}
