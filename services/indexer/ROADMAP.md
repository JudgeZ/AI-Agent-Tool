# Indexer Service Roadmap

## Current Status (v1.1)

The indexer service provides **advanced code indexing functionality** with the following implemented features:

### ✅ Implemented Features

#### 1. Core Indexing
- **Symbol Indexing** (`IndexSymbols`): Store code symbols (functions, classes, variables, etc.) with metadata.
- **Document Indexing** (`IndexDocument`): Store full document content with vector embeddings.
- **Symbol Retrieval** (`GetSymbol`): Retrieve individual symbols by ID.
- **Path-based Queries** (`QuerySymbols`): Query symbols by file path.

#### 2. Semantic Search (Phase 2)
- **Vector Search** (`SearchSymbols`, `SearchDocuments`):
  - Embedding generation using local BERT models or OpenAI API.
  - Vector database integration (PostgreSQL with `pgvector`).
  - Semantic similarity search for natural language queries.

#### 3. Code Navigation (Phase 3)
- **Symbol Graph** (`GetSymbolGraph`):
  - AST parsing using `tree-sitter` for Rust, TypeScript, JavaScript.
  - Basic call graph construction.
- **Find References** (`GetReferences`):
  - Cross-file reference tracking (AST-based).
  - Symbol usage analysis.
- **Go-to-Definition** (`GetDefinitions`):
  - Symbol resolution across modules.

#### 4. Temporal Analysis (Phase 4)
- **Symbol History** (`GetSymbolHistory`):
  - Git integration via `libgit2`.
  - Track symbol evolution over time.
- **Time-Travel Queries** (`GetSymbolAtCommit`):
  - Retrieve code state at any historical commit.
  - Diff-based symbol tracking.

#### 5. Intelligence (Phase 5)
- **CI/CD Failure Correlation** (`CorrelateFailure`):
  - Link test failures to recent code changes.
  - Relevance scoring based on path and failure messages.

#### 6. Security
- **DLP Scanning**: Credit card, SSN, API key detection.
- **ACL**: Path-based access control.
- **Audit Logging**: Structured logs for all operations.

---

## Development Roadmap

### Phase 6: Advanced Intelligence (v2.0) 📋 PLANNED
**Timeline**: Q2 2025
**Estimated Effort**: 6-8 weeks

**Deliverables**:
1. **Automated Code Review**:
   - ML-based suggestions for code improvements.
   - Security vulnerability detection using LLMs.
2. **Impact Analysis**:
   - Predict impact of changes on dependent modules.
3. **Anomaly Detection**:
   - Identify unusual code patterns or commits.

### Phase 7: Scalability & Distribution (v2.5) 📋 PLANNED
**Timeline**: Q3 2025
**Estimated Effort**: 4-5 weeks

**Deliverables**:
1. **Distributed Indexing**:
   - Sharding index across multiple nodes.
   - Horizontal scaling for large monorepos.
2. **Incremental Indexing**:
   - Optimized delta updates for CI/CD pipelines.

---

## Migration Guide

### Upgrading from v1.0 to v1.1

1. **Database Schema**:
   - Run migration scripts to add `pgvector` support and new tables.
   - Ensure PostgreSQL 15+ is installed.

2. **Configuration**:
   - Set `GIT_REPO_PATH` env var for temporal features.
   - Set `DATABASE_URL` to point to the PostgreSQL instance.

### Client Updates

- Update gRPC clients to use the new methods defined in `proto/indexer.proto`.
- Handle new message types for `GetSymbolGraph`, `GetSymbolHistory`, etc.

---

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](../../CONTRIBUTING.md) for details.

**High-Priority Contributions Wanted**:
- Support for additional languages (Python, Go, Java).
- Improved call graph accuracy (cross-file resolution).
- Performance optimizations for large git repositories.

---

## Questions?

- **API Documentation**: See `proto/indexer.proto`.
- **Issues**: File bugs on GitHub.
- **Discussion**: Join our community chat.

**Last Updated**: 2025-05-20
**Current Version**: v1.1
