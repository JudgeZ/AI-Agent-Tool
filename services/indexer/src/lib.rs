// Library exports for the indexer service

pub mod ast;
pub mod audit;
pub mod embeddings;
pub mod lsp;
pub mod request_context;
pub mod security;
// pub mod semantic;
pub mod storage;
pub mod symbol_extractor;
pub mod symbol_registry;
pub mod telemetry;
pub mod temporal;
pub mod validation;

// Re-export commonly used types
pub use embeddings::{EmbeddingConfig, EmbeddingManager, EmbeddingProvider};
// pub use semantic::{SemanticConfig, SemanticStore};
pub use storage::{IndexStorage, StorageConfig, StorageError, StoredDocument, StoredSymbol};

#[cfg(test)]
pub mod test_support;
