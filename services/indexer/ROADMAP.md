# Indexer Service Roadmap

## Current Status (v1.0)

The indexer service provides **basic code indexing functionality** with the following implemented features:

### ✅ Implemented Features

1. **Symbol Indexing** (`IndexSymbols`)
   - Store code symbols (functions, classes, variables, etc.)
   - Batch symbol storage for performance
   - Symbol metadata tracking (path, name, kind, location)

2. **Symbol Retrieval** (`GetSymbol`)
   - Retrieve individual symbols by ID
   - Full symbol metadata access

3. **Path-based Symbol Queries** (`QuerySymbols`)
   - Query symbols by file path
   - Streaming results for large symbol sets

4. **Document Indexing** (`IndexDocument`)
   - Store full document content
   - Document metadata and versioning
   - Path-based document organization

5. **Document Retrieval** (`GetDocument`)
   - Retrieve documents by ID
   - Access document content and metadata

6. **Deletion Operations** (`DeleteByPath`)
   - Remove symbols and documents by path
   - Cleanup stale index entries

7. **Security Features**
   - DLP (Data Loss Prevention) scanning
   - Credit card detection with Luhn validation
   - SSN, passport, API key pattern detection
   - PII redaction (email, phone, address)
   - Path traversal protection

### ❌ Not Yet Implemented (Planned for v2.0)

The following features return `Status::unimplemented()` errors and are planned for future releases:

#### 1. **Semantic Search** (`SearchSymbols`, `SearchDocuments`)
- **Status**: Not implemented
- **Requirements**: 
  - Embedding generation (OpenAI, local models, or similar)
  - Vector database integration (pgvector, Qdrant, Milvus, or Weaviate)
  - Similarity search algorithms
- **Use Case**: Natural language code search ("find authentication functions")
- **Workaround**: Use `QuerySymbols` for path-based searches

#### 2. **Symbol Graph & Relationships** (`GetSymbolGraph`)
- **Status**: Not implemented
- **Requirements**:
  - AST parsing for multiple languages
  - Call graph construction
  - Dependency analysis
  - Graph storage and querying
- **Use Case**: Visualize code relationships, impact analysis
- **Workaround**: None currently available

#### 3. **Find References** (`GetReferences`)
- **Status**: Not implemented
- **Requirements**:
  - AST parsing
  - Cross-file reference tracking
  - Symbol usage analysis
- **Use Case**: "Find all usages of this function"
- **Workaround**: Use external tools or IDE features

#### 4. **Go-to-Definition** (`GetDefinitions`)
- **Status**: Not implemented
- **Requirements**:
  - AST parsing
  - Symbol resolution across modules
  - Import/export tracking
- **Use Case**: Navigate from symbol usage to its definition
- **Workaround**: Use external tools or IDE features

#### 5. **Symbol History** (`GetSymbolHistory`)
- **Status**: Not implemented
- **Requirements**:
  - Git integration (libgit2)
  - Historical code parsing
  - Diff analysis for symbols
  - Temporal indexing
- **Use Case**: Track how a function evolved over time
- **Workaround**: Use git blame or history directly

#### 6. **Time-Travel Queries** (`GetSymbolAtCommit`)
- **Status**: Not implemented
- **Requirements**:
  - Git integration
  - Historical symbol extraction
  - Commit-aware indexing
- **Use Case**: "What did this function look like in commit abc123?"
- **Workaround**: Git checkout and manual inspection

#### 7. **CI/CD Failure Correlation** (`CorrelateFailure`)
- **Status**: Not implemented
- **Requirements**:
  - CI/CD system integration (GitHub Actions, Jenkins, etc.)
  - ML-based correlation analysis
  - Test failure tracking
  - Code change impact prediction
- **Use Case**: "Which code changes likely caused this test failure?"
- **Workaround**: Manual code review and git bisect

---

## Development Roadmap

### Phase 1: Foundation (Current - v1.0) ✅ COMPLETE
- Basic symbol and document indexing
- Storage layer (PostgreSQL)
- Security features (DLP, path validation)
- gRPC service infrastructure

### Phase 2: Vector Search (v2.0) 🔄 IN PROGRESS
**Timeline**: Q2 2025  
**Estimated Effort**: 3-4 weeks

**Deliverables**:
1. Choose vector database backend (recommendation: pgvector for PostgreSQL)
2. Integrate embedding generation (OpenAI API or local models)
3. Implement `SearchSymbols` with semantic search
4. Implement `SearchDocuments` with full-text search
5. Add vector similarity search to storage layer
6. Performance testing and optimization
7. Documentation and examples

**Prerequisites**:
- PostgreSQL with pgvector extension
- Embedding API credentials or local model setup
- Vector dimension configuration (typically 768 or 1536)

### Phase 3: Code Navigation (v2.5) 📋 PLANNED
**Timeline**: Q3 2025  
**Estimated Effort**: 5-6 weeks

**Deliverables**:
1. Multi-language AST parsing (tree-sitter or similar)
2. Symbol resolution across files
3. Implement `GetSymbolGraph` (call graph, dependency graph)
4. Implement `GetReferences` (find all usages)
5. Implement `GetDefinitions` (go-to-definition)
6. Cross-language support (TypeScript, Go, Rust, Python)
7. Graph visualization API

**Prerequisites**:
- tree-sitter library integration
- Language-specific grammars
- Graph storage (Neo4j or PostgreSQL with graph extensions)

### Phase 4: Temporal Analysis (v3.0) 📋 PLANNED
**Timeline**: Q4 2025  
**Estimated Effort**: 4-5 weeks

**Deliverables**:
1. Git integration with libgit2
2. Historical code indexing
3. Implement `GetSymbolHistory` (symbol evolution)
4. Implement `GetSymbolAtCommit` (time-travel queries)
5. Diff-based symbol tracking
6. Blame information integration
7. Performance optimization for large repositories

**Prerequisites**:
- libgit2 Rust bindings
- Git repository access
- Storage for historical data (partition strategies)

### Phase 5: Intelligence Features (v3.5) 📋 PLANNED
**Timeline**: Q1 2026  
**Estimated Effort**: 6-8 weeks

**Deliverables**:
1. CI/CD system integrations (GitHub Actions, Jenkins)
2. ML model for failure correlation
3. Implement `CorrelateFailure`
4. Test impact analysis
5. Code quality metrics
6. Automated code review suggestions
7. Anomaly detection

**Prerequisites**:
- CI/CD API access
- ML framework (PyTorch or similar)
- Training data collection
- Feature engineering pipeline

---

## Migration Guide

### For Clients Using Unimplemented Features

If your code currently calls any of the unimplemented endpoints, you will receive a gRPC `UNIMPLEMENTED` error (code 12) with a descriptive message.

**Example Error**:
```
Status { code: Unimplemented, message: "Semantic symbol search is not yet implemented. This feature is planned for v2.0. Use QuerySymbols for path-based symbol queries." }
```

**Recommended Actions**:

1. **Check gRPC Status Codes**: Handle `UNIMPLEMENTED` status gracefully in your client code
   
2. **Use Available Alternatives**:
   - For semantic search → Use `QuerySymbols` with path patterns
   - For references/definitions → Use language server protocol (LSP) tools
   - For history → Use git commands directly
   
3. **Feature Detection**: Before calling unimplemented features, check service capabilities or catch errors

4. **Subscribe to Updates**: Watch the GitHub repository for v2.0 release announcements

### Example Client Code (Rust)

```rust
use tonic::Code;

match indexer_client.search_symbols(request).await {
    Ok(response) => {
        // Feature is implemented
        process_results(response);
    }
    Err(status) if status.code() == Code::Unimplemented => {
        // Feature not yet available - use fallback
        log::warn!("Semantic search not available, using path-based search");
        fallback_to_query_symbols();
    }
    Err(e) => {
        // Other error
        log::error!("Search failed: {}", e);
    }
}
```

---

## Contributing

If you'd like to help implement any of these features:

1. Check the [GitHub Issues](https://github.com/yourorg/oss-ai-agent-tool/issues) for related work
2. Read the [IMPLEMENTATION_SUMMARY.md](../../docs/implementation/IMPLEMENTATION_SUMMARY.md) for architecture details
3. Review [CLAUDE.md](../../CLAUDE.md) for coding standards
4. Open a discussion or draft PR for design feedback
5. Follow the testing requirements (≥60% coverage for indexer)

**High-Priority Contributions Wanted**:
- Vector search implementation (Phase 2)
- tree-sitter AST parsing integration (Phase 3)
- Git integration with libgit2 (Phase 4)

---

## Questions?

- **API Documentation**: See `proto/indexer.proto` for full service definition
- **Architecture**: See `docs/implementation/` for design documents
- **Issues**: File bugs or feature requests on GitHub
- **Discussion**: Join our community chat for questions

---

**Last Updated**: 2025-01-17  
**Current Version**: v1.0  
**Next Planned Release**: v2.0 (Q2 2025)
