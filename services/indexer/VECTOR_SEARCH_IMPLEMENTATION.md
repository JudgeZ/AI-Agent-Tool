# Vector Similarity Search Implementation

## Overview

This document describes the PostgreSQL-based vector similarity search implementation for the indexer service using pgvector extension.

## Completed Features

### 1. Database Schema (migrations/001_initial_schema.sql)

- **pgvector Extension**: Enabled for vector operations
- **Tables**:
  - `symbols`: Stores code symbols with 384-dimensional embeddings (all-MiniLM-L6-v2)
  - `documents`: Stores full documents with embeddings
  - `symbol_relationships`: Tracks relationships between symbols
  - `symbol_versions`: Maintains symbol history across commits

- **Indexes**:
  - HNSW indexes on embeddings for fast approximate nearest neighbor search
  - B-tree indexes on path, commit_id, and kind for filtering
  - Composite indexes for common query patterns

### 2. PostgreSQL Storage Backend (src/storage.rs)

Implemented all IndexStorage trait methods for PostgresStorage:

#### Storage Operations
- `initialize()`: Runs migrations to set up schema with pgvector
- `store_symbol()`: Stores individual symbols with vector embeddings
- `store_symbols_batch()`: Batch insertion with transaction support
- `store_document()`: Stores full documents with embeddings
- `store_documents_batch()`: Batch document insertion

#### Retrieval Operations
- `get_symbol()`: Retrieves symbol by UUID
- `get_document()`: Retrieves document by UUID
- `query_symbols_by_path()`: Lists all symbols in a file

#### Vector Search Operations
- `search_symbols()`: Vector similarity search with cosine distance
  - Supports path prefix filtering
  - Supports commit ID filtering
  - Supports kind filtering (function, class, interface, etc.)
  - Configurable similarity threshold
  - HNSW index for sub-linear search performance
  
- `search_documents()`: Similar vector search for documents

#### Maintenance Operations
- `delete_symbols_by_path()`: Removes all symbols from a file
- `delete_documents_by_path()`: Removes all documents from a path
- `stats()`: Returns storage statistics (counts, sizes, index sizes)
- `vacuum()`: Runs VACUUM ANALYZE to reclaim space and update statistics
- `checkpoint()`: No-op for PostgreSQL (automatic checkpointing)

## Technical Details

### Vector Similarity Search

The implementation uses PostgreSQL's pgvector extension with the following approach:

1. **Distance Metric**: Cosine similarity (`<=>` operator)
   ```sql
   1 - (embedding <=> query_vector) as similarity
   ```

2. **Index Type**: HNSW (Hierarchical Navigable Small World)
   - Parameter `m = 16`: Number of connections per layer
   - Parameter `ef_construction = 64`: Size of dynamic candidate list during construction
   - Provides excellent recall with sub-linear query time

3. **Query Pattern**:
   ```sql
   SELECT * FROM symbols
   WHERE 1 - (embedding <=> $1::vector) >= threshold
     AND path LIKE prefix || '%'
     AND commit_id = $2
     AND kind = ANY($3)
   ORDER BY embedding <=> $1::vector
   LIMIT k
   ```

### Performance Characteristics

- **HNSW Index Build**: O(n log n) time, O(n) space
- **Query Time**: O(log n) approximate
- **Recall**: ~95% at ef_search=64 (can be tuned)
- **Storage Overhead**: ~1.5x embedding size for index

### Data Types

- **Embeddings**: JSON-serialized `Vec<f32>` converted to PostgreSQL `vector` type
- **Metadata**: JSONB for flexible schema
- **Timestamps**: `timestamptz` for UTC timestamps
- **UUIDs**: Native PostgreSQL UUID type

## Integration Points

### Symbol Extraction

The vector search backend integrates with:
- `symbol_extractor.rs`: Extracts symbols from source code
- `symbol_registry.rs`: Manages stable UUIDs for symbols
- `embeddings.rs`: Generates vector embeddings (TODO)

### gRPC Service

Will be exposed via:
- `SearchSymbols` RPC: Symbol similarity search
- `SearchDocuments` RPC: Document similarity search
- `GetSymbol` RPC: Symbol retrieval by ID

## Configuration

PostgreSQL storage is configured via `StorageConfig`:

```rust
StorageConfig {
    database_url: "postgresql://user:pass@host/db",
    max_connections: 10,
    // Note: WAL and auto_vacuum settings only apply to SQLite
}
```

## Future Enhancements

1. **Hybrid Search**: Combine vector similarity with full-text search
2. **Reranking**: Use cross-encoder models for more accurate ranking
3. **Quantization**: Reduce embedding size with PQ or scalar quantization
4. **Incremental Updates**: Optimize for rapid re-indexing
5. **Multi-vector Search**: Store multiple embeddings per symbol (code + docs)

## Testing

The implementation includes:
- Unit tests for serialization/deserialization
- Integration tests for basic CRUD operations (SQLite only currently)
- TODO: Add PostgreSQL integration tests with testcontainers

## Security Considerations

- **Input Validation**: All inputs validated via type system and SQL parameter binding
- **SQL Injection**: Prevented through parameterized queries
- **Resource Limits**: Connection pooling prevents resource exhaustion
- **Audit Logging**: Operations logged with structured logging

## Observability

All operations emit:
- **Logs**: Structured logs with trace context
- **Metrics**: TODO - Add Prometheus metrics for query latency, index size, etc.
- **Tracing**: TODO - Add OpenTelemetry spans for search operations
