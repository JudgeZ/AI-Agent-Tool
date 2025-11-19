# Indexer Service

The Indexer service provides semantic search, AST parsing, and temporal analysis capabilities for the OSS AI Agent Tool. It's built in Rust for performance and safety.

## Features

- **Semantic Search**: Vector embeddings and similarity search for code and documentation. Supports **Local (Candle/BERT)** and **Remote (Orchestrator)** embedding providers.
- **Code Navigation**: AST-based definition and reference tracking.
- **Temporal Analysis**: Change tracking and commit history integration.
- **Intelligence**: CI/CD failure correlation and impact analysis.
- **Security**: ACL-based path validation, DLP pattern detection, audit logging.
- **Storage**: **SQLite** (default) or PostgreSQL-backed persistent storage.

## Prerequisites

### System Requirements

- Rust 1.75 or later
- Protocol Buffers compiler (protoc)
- SQLite 3 (default) or PostgreSQL (optional enterprise backend)

### Installing Protocol Buffers Compiler

The indexer uses gRPC and Protocol Buffers for communication. You must have `protoc` installed or available.

## Configuration

The service is configured via `config.toml` (copy from `config.example.toml`) and environment variables.

### Key Settings

*   **Embedding Provider:**
    *   `provider = "local"`: Uses on-device BERT model (CPU/GPU) via Candle.
    *   `provider = "orchestrator"`: Delegates to the Orchestrator API (e.g., OpenAI/Azure).
*   **Storage:**
    *   `backend = "sqlite"`: Single-file DB (Consumer mode).
    *   `backend = "postgres"`: Scalable DB (Enterprise mode).

See `config.example.toml` for all options. Environment variables (e.g., `INDEXER_PORT`, `DATABASE_URL`) override file settings.

## Development

### Running Tests

```bash
cargo test
```

### Code Quality

```bash
# Run clippy for lints
cargo clippy

# Format code
cargo fmt
```
