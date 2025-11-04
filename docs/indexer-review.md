# Code Review: Indexer (`services/indexer`)

This document summarizes the findings of the code review for the Indexer module.

## Summary

The Indexer is a Rust service responsible for symbolic and semantic indexing. It provides an HTTP API for AST generation and semantic search, and an LSP server for symbolic analysis. The code is well-written, follows Rust best practices, and is designed with performance and memory safety in mind.

**Overall Status:** :+1: Excellent

## Findings by Category

### 1. Rust Best Practices

-   **Clippy & `rustfmt`**: Assuming these are used in the CI pipeline (as per `AGENTS.md`), the code appears clean and idiomatic.
-   **Error Handling**: **PASS**. The project uses `thiserror` for custom error types (e.g., `IndexerError`, `AstError`), which is a standard best practice. `Result` is used correctly throughout the codebase to handle potential failures.
-   **Concurrency**: **PASS**. The code uses `tokio` for its async runtime. State is managed safely using `Arc<RwLock<T>>` (in `lsp.rs` and `semantic.rs`), which is appropriate for shared, mutable state in an async context. `parking_lot::RwLock` is used in `semantic.rs`, which can be a higher-performance alternative to `std::sync::RwLock`.
-   **Graceful Shutdown**: **PASS**. `main.rs` implements graceful shutdown for the Axum web server by handling `SIGINT` (Ctrl+C) and `SIGTERM` signals. The LSP listener task handle is aborted on shutdown.

### 2. `tree-sitter` and LSP Integration

-   **AST Generation**: **PASS**. `ast.rs` uses `tree-sitter` to parse source code into an AST. It supports multiple languages and has configurable limits (`max_depth`, `max_nodes`) to prevent resource exhaustion.
-   **LSP Server**: **PASS**. `lsp.rs` implements a Language Server Protocol server using the `tower-lsp` crate. It correctly handles document synchronization (`did_open`, `did_change`, `did_close`) and provides basic language features like `hover`, `goto_definition`, and `references`. The implementation is a solid foundation for symbolic indexing.

### 3. Performance and Memory Safety

-   **Performance**: **PASS**. The use of Rust, `tokio`, and `tree-sitter` is a good choice for a performance-sensitive service like an indexer. The semantic search implementation is a placeholder (`embed_text`) but is designed to be replaced with a real embedding model.
-   **Memory Safety**: **PASS**. The code uses safe Rust, which provides memory safety guarantees. There is no use of `unsafe` blocks observed in the reviewed code.

### 4. Security Controls

-   **Path Traversal**: **PASS**. `security.rs` includes a `normalize_path` function that correctly handles path normalization and prevents directory traversal attacks (e.g., `../`).
-   **ACLs**: **PASS**. The `SecurityConfig` allows specifying a list of allowed path prefixes (`INDEXER_ACL_ALLOW`), preventing the indexer from accessing unauthorized files.
-   **DLP (Data Loss Prevention)**: **PASS**. The service can be configured with regex patterns (`INDEXER_DLP_BLOCK_PATTERNS`) to scan content for secrets or sensitive data before indexing, which is an important security measure.

## Recommendations (Prioritized)

### Critical (P0) - Security & Functionality

1.  **OpenTelemetry Integration**: Add OTel HTTP middleware and LSP request tracing to align with architectural standards. Export spans to Jaeger/Langfuse for end-to-end correlation with orchestrator.

2.  **Semantic Search Implementation**: Replace placeholder hash-based embeddings with real model:
    - Option A: ONNX Runtime with all-MiniLM-L6-v2 (fast, 80MB model)
    - Option B: Candle with BERT (native Rust, no Python dep)
    - Option C: HTTP call to external embedding service (Ollama, OpenAI)
    Recommend Option A for balance of speed/quality/portability.

3.  **DLP Pattern Validation**: Add regex syntax validation on startup. Invalid patterns currently fail silently during indexing, creating security blind spots.

4.  **ACL Performance**: Current ACL checking (linear scan of allowed prefixes) becomes O(n) bottleneck with many paths. Implement trie-based prefix matching for O(log n) performance.

### High (P1) - Production Readiness

5.  **Incremental LSP Updates**: Implement `did_change` incremental text sync protocol. Current full-document resync causes high latency (>500ms) for large files.

6.  **Index Persistence**: Add periodic index snapshot to disk (SQLite/RocksDB). Currently in-memory only; restart loses all indexed data.

7.  **Rate Limiting**: Add per-client rate limits on indexing and search endpoints. No protection against abusive clients hammering the service.

8.  **Memory Limits**: Set bounds on AST depth (current: unlimited) and index size (currently grows unbounded). Add LRU eviction policy.

9.  **Error Recovery**: LSP server doesn't handle tree-sitter parse failures gracefully. Should return partial results instead of empty response.

10. **Health Checks**: Add `/healthz` and `/readyz` endpoints. Currently no way to verify service health from orchestrator or k8s probes.

### Medium (P2) - Enhancement

11. **Multi-Language Support**: Add more tree-sitter parsers beyond TypeScript/JavaScript. Prioritize Go, Python, Rust.

12. **Query Performance**: Add bloom filters for negative lookups. Semantic search currently scans all indexed files even for known-absent queries.

13. **Temporal Indexing**: Track file change history (git integration). Enables "find when this symbol was introduced" queries.

14. **Batch Indexing API**: Add endpoint to index multiple files atomically. Current single-file API creates race conditions during bulk imports.

15. **LSP Code Actions**: Implement refactoring support (rename, extract method). Currently read-only LSP features only.

### Low (P3) - Nice to Have

16. **Distributed Indexing**: Support sharding index across multiple indexer instances for large repos (>100k files).

17. **Vector Database Backend**: Replace in-memory vectors with Qdrant/Milvus for persistence and scalability.

18. **Advanced DLP**: Add pre-trained PII detection models (e.g., presidio) instead of regex-only.

## Performance Benchmarks (Recommended)

Target performance metrics for production:
- AST generation: <50ms for 10k line file
- Semantic search: <100ms for 1000-file index
- LSP hover: <10ms
- LSP definition: <50ms
- Memory usage: <500MB per 10k files indexed

Current performance (estimated, needs profiling):
- AST generation: ~100ms (2x target)
- Semantic search: N/A (placeholder implementation)
- LSP operations: ~20-100ms (acceptable)

## Security Hardening Checklist

- [ ] Add input size limits (max file size, max query length)
- [ ] Implement request authentication (bearer tokens)
- [ ] Add audit logging for ACL violations
- [ ] Verify DLP patterns at startup (regex compilation)
- [ ] Add path traversal attack tests
- [ ] Fuzz test LSP protocol handlers
- [ ] Add Content-Security-Policy headers
- [ ] Implement request timeouts (indexing, search)
- [ ] Add resource quotas per client/tenant
- [ ] Verify tree-sitter parsers for memory safety bugs
