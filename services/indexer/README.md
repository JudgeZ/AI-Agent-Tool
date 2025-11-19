# Indexer Service

The Indexer service provides semantic search, AST parsing, and temporal analysis capabilities for the OSS AI Agent Tool. It's built in Rust for performance and safety.

## Features

- **Semantic Search**: Vector embeddings and similarity search for code and documentation
- **AST Parsing**: TypeScript/JavaScript abstract syntax tree analysis
- **Security**: ACL-based path validation, DLP pattern detection, audit logging
- **Temporal Analysis**: Change tracking and commit history integration
- **Storage**: SQLite-backed persistent storage with embedding serialization
- **LSP Integration**: Language Server Protocol identifier detection

## Prerequisites

### System Requirements

- Rust 1.75 or later
- Protocol Buffers compiler (protoc)
- SQLite 3

### Installing Protocol Buffers Compiler

The indexer uses gRPC and Protocol Buffers for communication. You must have `protoc` installed or available.

#### Option 1: Use the bundled protoc (Recommended for this project)

If you're in the project root and have the `protoc` directory:

```bash
# Windows
export PROTOC="../../protoc/bin/protoc.exe"

# Linux/macOS
export PROTOC="../../protoc/bin/protoc"
```

#### Option 2: Install protoc system-wide

**Windows:**
```powershell
# Using Chocolatey
choco install protoc

# Or download from https://github.com/protocolbuffers/protobuf/releases
```

**macOS:**
```bash
brew install protobuf
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get install protobuf-compiler
```

**Linux (Fedora/RHEL):**
```bash
sudo dnf install protobuf-compiler
```

## Building

```bash
cd services/indexer

# If using bundled protoc (Windows)
set PROTOC=../../protoc/bin/protoc.exe

# If using bundled protoc (Linux/macOS)
export PROTOC=../../protoc/bin/protoc

# Build
cargo build --release
```

## Running Tests

```bash
cd services/indexer

# Set PROTOC environment variable (Windows)
set PROTOC=../../protoc/bin/protoc.exe

# Run all tests
cargo test

# Run tests with output
cargo test -- --nocapture

# Run specific test
cargo test test_name
```

### Test Coverage

The indexer has comprehensive test coverage across all modules:

- **AST Parsing**: TypeScript/JavaScript parsing, unknown language handling
- **Security**: ACL validation, DLP pattern detection, path traversal prevention
- **Semantic Search**: Document indexing, similarity search, eviction policies
- **Storage**: SQLite operations, embedding serialization
- **Temporal**: Change tracking, CI status, relevance calculation
- **Audit**: Identity hashing, sensitive key redaction

**Current Test Count**: 70+ tests (34 unit tests + 36 integration tests)

## Configuration

The indexer is configured via environment variables:

### Required
- `INDEXER_PORT`: Port to listen on (default: 8082)
- `INDEXER_BIND_ADDR`: Address to bind (default: 127.0.0.1:8082)

### Optional
- `INDEXER_ACL_ALLOW_PREFIXES`: Comma-separated path prefixes for ACL (e.g., `/src,/lib`)
- `INDEXER_DLP_BLOCK_PATTERNS`: Custom regex patterns for data loss prevention
- `INDEXER_AUDIT_SALT`: Salt for hashing identities in audit logs
- `INDEXER_EMBEDDING_PROVIDER`: Embedding provider (e.g., `ollama`, `openai`)
- `INDEXER_EMBEDDING_MODEL`: Model to use for embeddings

### Security Configuration

The indexer implements defense-in-depth security:

1. **ACL (Access Control Lists)**: Path-based access control via allow-list
2. **DLP (Data Loss Prevention)**: Pattern-based detection of secrets, PII
3. **Audit Logging**: Structured logs with hashed identities
4. **Input Validation**: All external inputs validated at boundaries

## Running the Service

```bash
# Development
cargo run

# Production (requires build first)
./target/release/ossaat-indexer
```

## gRPC API

The indexer exposes a gRPC API defined in `proto/indexer.proto`. Key services:

- **IndexDocument**: Add documents to the semantic index
- **SearchDocuments**: Semantic similarity search
- **ParseAST**: Parse TypeScript/JavaScript to AST
- **GetHistory**: Retrieve temporal/CI history
- **HealthCheck**: Service health status

## Architecture

```
┌─────────────────────────────────────────┐
│           gRPC Server                    │
│  (proto/indexer.proto)                   │
└────────────┬────────────────────────────┘
             │
    ┌────────┴────────┐
    │                 │
┌───▼────┐      ┌────▼─────┐
│ AST    │      │ Semantic │
│ Parser │      │ Search   │
└────────┘      └──────┬───┘
                       │
                ┌──────▼──────┐
                │  Embeddings │
                │  (Provider) │
                └──────┬──────┘
                       │
                ┌──────▼──────┐
                │   Storage   │
                │  (SQLite)   │
                └─────────────┘
```

### Key Modules

- `main.rs` / `lib.rs`: Entry point and core logic
- `grpc_service.rs`: gRPC service implementation
- `semantic.rs`: Semantic search engine
- `embeddings.rs`: Embedding provider abstraction
- `storage.rs`: SQLite persistence layer
- `ast.rs`: Abstract syntax tree parsing
- `temporal.rs`: Change tracking and CI integration
- `security.rs`: ACL, DLP, and validation
- `audit.rs`: Structured audit logging
- `lsp.rs`: Language Server Protocol utilities

## Troubleshooting

### Build Errors

**Error: "Could not find `protoc`"**
```
Solution: Install protoc or set PROTOC environment variable:
  export PROTOC=/path/to/protoc
```

**Error: "sqlx-postgres future incompatibility warning"**
```
This is a warning only. The code works but the dependency
needs updating. Run:
  cargo report future-incompatibilities --id 1
```

### Test Failures

**Error: DLP pattern compilation failed**
```
Check INDEXER_DLP_BLOCK_PATTERNS environment variable.
Invalid regex patterns are skipped in consumer mode but
cause panics in enterprise mode.
```

## Development

### Adding New Tests

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_feature() {
        // Test implementation
        assert_eq!(expected, actual);
    }
}
```

### Debugging

Enable Rust logging:
```bash
RUST_LOG=debug cargo run
```

### Code Quality

```bash
# Run clippy for lints
cargo clippy

# Format code
cargo fmt

# Check without building
cargo check
```

## Performance Considerations

- **Embedding Cache**: Embeddings are cached to reduce redundant computation
- **Batch Processing**: Documents can be indexed in batches
- **Connection Pooling**: SQLite connections are pooled
- **Memory Management**: Least-recently-used eviction for in-memory caches

## Security Best Practices

1. **Never commit** `INDEXER_AUDIT_SALT` to version control
2. **Restrict** `INDEXER_ACL_ALLOW_PREFIXES` to necessary paths only
3. **Review** DLP patterns regularly for coverage
4. **Monitor** audit logs for suspicious activity
5. **Use** HTTPS/TLS for production gRPC endpoints

## Contributing

Follow the guidelines in `/CLAUDE.md`:

- Write tests for all new features
- Run `cargo test` and `cargo clippy` before committing
- No `unsafe` code without justification
- Document public APIs with doc comments
- Keep PRs focused on single concerns

## License

See the root LICENSE file for details.
