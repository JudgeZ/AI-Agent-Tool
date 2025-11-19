use std::env;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use futures::StreamExt;
use pgvector::Vector;
use serde::{Deserialize, Serialize};
use sqlx::postgres::{PgPool, PgPoolOptions, PgRow};
use sqlx::{FromRow, Row};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("document not found: {0}")]
    DocumentNotFound(String),
    #[error("symbol not found: {0}")]
    SymbolNotFound(String),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("embedding error: {0}")]
    Embedding(String),
    #[error("configuration error: {0}")]
    Configuration(String),
}

impl From<StorageError> for tonic::Status {
    fn from(err: StorageError) -> Self {
        match err {
            StorageError::DocumentNotFound(_) => tonic::Status::not_found(err.to_string()),
            StorageError::SymbolNotFound(_) => tonic::Status::not_found(err.to_string()),
            StorageError::Database(_) => tonic::Status::internal(err.to_string()),
            StorageError::InvalidInput(_) => tonic::Status::invalid_argument(err.to_string()),
            StorageError::Embedding(_) => tonic::Status::internal(err.to_string()),
            StorageError::Configuration(_) => tonic::Status::internal(err.to_string()),
        }
    }
}

#[derive(Clone, Debug)]
pub struct StorageConfig {
    pub database_url: String,
    pub max_connections: u32,
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self::from_env().expect("Failed to load configuration from environment")
    }
}

impl StorageConfig {
    pub fn from_env() -> Result<Self, StorageError> {
        Ok(Self {
            database_url: env::var("DATABASE_URL")
                .map_err(|_| StorageError::Configuration("DATABASE_URL must be set".to_string()))?,
            max_connections: env::var("DATABASE_MAX_CONNECTIONS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(5),
        })
    }
}

#[derive(Clone, Debug, FromRow)]
pub struct StoredDocument {
    pub id: Uuid,
    pub path: String,
    pub content: String,
    #[sqlx(skip)]
    #[allow(dead_code)]
    pub embedding: Vec<f32>,
    pub commit_id: Option<String>,
    #[allow(dead_code)]
    pub created_at: DateTime<Utc>,
    #[allow(dead_code)]
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, FromRow)]
pub struct StoredSymbol {
    pub id: Uuid,
    pub path: String,
    pub name: String,
    pub kind: String,
    pub content: String,
    #[sqlx(skip)]
    pub embedding: Vec<f32>,
    pub commit_id: Option<String>,
    pub start_line: i32, // Changed to i32 for DB compatibility
    pub end_line: i32,   // Changed to i32 for DB compatibility
    #[sqlx(json)]
    pub metadata: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[async_trait::async_trait]
pub trait IndexStorage: Send + Sync {
    async fn query_all_symbols(&self) -> Result<Vec<StoredSymbol>, StorageError>;
    async fn store_symbol(&self, symbol: &StoredSymbol) -> Result<(), StorageError>;
}

#[derive(Clone)]
pub struct Storage {
    pool: PgPool,
    embedding_manager: Arc<crate::embeddings::EmbeddingManager>,
}

impl Storage {
    pub async fn new(config: StorageConfig) -> Result<Self, StorageError> {
        let pool = PgPoolOptions::new()
            .max_connections(config.max_connections)
            .connect(&config.database_url)
            .await?;

        // Initialize embedding manager
        let embedding_manager = Arc::new(
            crate::embeddings::EmbeddingManager::new(None)
                .map_err(|e| StorageError::Embedding(e.to_string()))?,
        );

        Ok(Self {
            pool,
            embedding_manager,
        })
    }

    pub async fn index_document(
        &self,
        path: String,
        content: String,
        commit_id: Option<String>,
    ) -> Result<Uuid, StorageError> {
        let embedding = self
            .embedding_manager
            .embed(&content)
            .await
            .map_err(|e| StorageError::Embedding(e.to_string()))?;

        let embedding_vector = Vector::from(embedding);
        let id = Uuid::new_v4();
        let now = Utc::now();

        sqlx::query(
            r#"
            INSERT INTO documents (id, path, content, embedding_vector, commit_id, created_at, updated_at, embedding_model, embedding_generated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $6)
            ON CONFLICT (path) DO UPDATE
            SET content = $3,
                embedding_vector = $4,
                commit_id = $5,
                updated_at = $6,
                embedding_generated_at = $6
            RETURNING id
            "#
        )
        .bind(id)
        .bind(path)
        .bind(content)
        .bind(embedding_vector)
        .bind(commit_id)
        .bind(now)
        .bind("all-MiniLM-L6-v2")
        .fetch_one(&self.pool)
        .await?;

        Ok(id)
    }

    pub async fn index_symbols(
        &self,
        path: String,
        content: String,
        language: String,
        commit_id: Option<String>,
    ) -> Result<usize, StorageError> {
        let extracted_symbols = crate::symbol_extractor::extract_symbols(&content, &language)
            .map_err(|e| StorageError::InvalidInput(format!("failed to extract symbols: {e}")))?;

        let mut symbol_count = 0;
        let mut symbols_to_store = Vec::new();

        fn flatten_symbols(
            extracted_symbols: Vec<crate::symbol_extractor::ExtractedSymbol>,
            path: &str,
            commit_id: Option<&String>,
            symbols_out: &mut Vec<StoredSymbol>,
        ) {
            for extracted in extracted_symbols {
                let symbol = StoredSymbol {
                    id: Uuid::new_v4(),
                    path: path.to_string(),
                    name: extracted.name,
                    kind: extracted.kind.to_string(),
                    content: extracted.content,
                    embedding: vec![], // Will be computed
                    commit_id: commit_id.cloned(),
                    start_line: extracted.range.start.line as i32,
                    end_line: extracted.range.end.line as i32,
                    metadata: extracted.doc_comment.map(|doc| serde_json::json!({"doc": doc})),
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                };
                symbols_out.push(symbol);
                flatten_symbols(extracted.children, path, commit_id, symbols_out);
            }
        }

        flatten_symbols(extracted_symbols, &path, commit_id.as_ref(), &mut symbols_to_store);

        // Now process symbols: generate embeddings and store
        // Use parallel processing for embeddings
        let concurrency = 4; // Adjust based on needs
        
        let results = futures::stream::iter(symbols_to_store)
            .map(|mut symbol| {
                let storage = self.clone();
                async move {
                    let embedding = storage
                        .embedding_manager
                        .embed(&symbol.content)
                        .await
                        .map_err(|e| StorageError::Embedding(e.to_string()))?;
                    
                    symbol.embedding = embedding;
                    Ok::<_, StorageError>(symbol)
                }
            })
            .buffer_unordered(concurrency)
            .collect::<Vec<_>>()
            .await;

        for result in results {
            let symbol = result?;
            let embedding_vector = Vector::from(symbol.embedding.clone());
            
            sqlx::query(
                r#"
                INSERT INTO symbols (id, path, name, kind, content, embedding_vector, commit_id, start_line, end_line, metadata, created_at, updated_at, embedding_model, embedding_generated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, $11)
                "#
            )
            .bind(symbol.id)
            .bind(symbol.path)
            .bind(symbol.name)
            .bind(symbol.kind)
            .bind(symbol.content)
            .bind(embedding_vector)
            .bind(symbol.commit_id)
            .bind(symbol.start_line)
            .bind(symbol.end_line)
            .bind(symbol.metadata)
            .bind(symbol.created_at)
            .bind("all-MiniLM-L6-v2")
            .execute(&self.pool)
            .await?;
            
            symbol_count += 1;
        }

        Ok(symbol_count)
    }

    pub async fn search_documents(
        &self,
        query: String,
        top_k: usize,
        path_prefix: Option<String>,
        commit_id: Option<String>,
    ) -> Result<Vec<(StoredDocument, f32)>, StorageError> {
        let query_embedding = self
            .embedding_manager
            .embed(&query)
            .await
            .map_err(|e| StorageError::Embedding(e.to_string()))?;
        
        let embedding_vector = Vector::from(query_embedding);
        let limit = top_k as i64;

        // Dynamic query construction is hard with sqlx macros, so we use query_as
        // Note: <=> is cosine distance, so we sort by ASC. 
        // Similarity = 1 - distance.
        
        let mut sql = String::from(
            r#"
            SELECT id, path, content, commit_id, created_at, updated_at, 
                   1 - (embedding_vector <=> $1) as score
            FROM documents
            WHERE 1=1
            "#
        );
        
        let mut args = sqlx::postgres::PgArguments::default();
        use sqlx::Arguments;
        args.add(embedding_vector);
        
        let mut param_idx = 2;

        if let Some(prefix) = path_prefix {
            sql.push_str(&format!(" AND path LIKE ${}", param_idx));
            args.add(format!("{}%", prefix));
            param_idx += 1;
        }

        if let Some(commit) = commit_id {
            sql.push_str(&format!(" AND commit_id = ${}", param_idx));
            args.add(commit);
            param_idx += 1;
        }

        sql.push_str(&format!(" ORDER BY embedding_vector <=> $1 ASC LIMIT ${}", param_idx));
        args.add(limit);

        let rows: Vec<PgRow> = sqlx::query_with(&sql, args)
            .fetch_all(&self.pool)
            .await?;

        let mut results = Vec::new();
        for row in rows {
            let doc = StoredDocument {
                id: row.try_get("id")?,
                path: row.try_get("path")?,
                content: row.try_get("content")?,
                embedding: vec![], // Not returning embedding to save bandwidth
                commit_id: row.try_get("commit_id")?,
                created_at: row.try_get("created_at")?,
                updated_at: row.try_get("updated_at")?,
            };
            let score: f64 = row.try_get("score")?; // pgvector returns float8/f64
            results.push((doc, score as f32));
        }

        Ok(results)
    }

    pub async fn search_symbols(
        &self,
        query: String,
        top_k: usize,
        path_prefix: Option<String>,
        commit_id: Option<String>,
    ) -> Result<Vec<(StoredSymbol, f32)>, StorageError> {
        let query_embedding = self
            .embedding_manager
            .embed(&query)
            .await
            .map_err(|e| StorageError::Embedding(e.to_string()))?;
        
        let embedding_vector = Vector::from(query_embedding);
        let limit = top_k as i64;

        let mut sql = String::from(
            r#"
            SELECT id, path, name, kind, content, commit_id, start_line, end_line, metadata, created_at, updated_at,
                   1 - (embedding_vector <=> $1) as score
            FROM symbols
            WHERE 1=1
            "#
        );
        
        let mut args = sqlx::postgres::PgArguments::default();
        use sqlx::Arguments;
        args.add(embedding_vector);
        
        let mut param_idx = 2;

        if let Some(prefix) = path_prefix {
            sql.push_str(&format!(" AND path LIKE ${}", param_idx));
            args.add(format!("{}%", prefix));
            param_idx += 1;
        }

        if let Some(commit) = commit_id {
            sql.push_str(&format!(" AND commit_id = ${}", param_idx));
            args.add(commit);
            param_idx += 1;
        }

        sql.push_str(&format!(" ORDER BY embedding_vector <=> $1 ASC LIMIT ${}", param_idx));
        args.add(limit);

        let rows: Vec<PgRow> = sqlx::query_with(&sql, args)
            .fetch_all(&self.pool)
            .await?;

        let mut results = Vec::new();
        for row in rows {
            let symbol = StoredSymbol {
                id: row.try_get("id")?,
                path: row.try_get("path")?,
                name: row.try_get("name")?,
                kind: row.try_get("kind")?,
                content: row.try_get("content")?,
                embedding: vec![],
                commit_id: row.try_get("commit_id")?,
                start_line: row.try_get("start_line")?,
                end_line: row.try_get("end_line")?,
                metadata: row.try_get("metadata")?,
                created_at: row.try_get("created_at")?,
                updated_at: row.try_get("updated_at")?,
            };
            let score: f64 = row.try_get("score")?;
            results.push((symbol, score as f32));
        }

        Ok(results)
    }
}

#[async_trait::async_trait]
impl IndexStorage for Storage {
    async fn query_all_symbols(&self) -> Result<Vec<StoredSymbol>, StorageError> {
        let symbols = sqlx::query_as::<_, StoredSymbol>(
            r#"
            SELECT id, path, name, kind, content, commit_id, start_line, end_line, metadata, created_at, updated_at
            FROM symbols
            "#
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(symbols)
    }

    async fn store_symbol(&self, symbol: &StoredSymbol) -> Result<(), StorageError> {
        // Note: This method is used by SymbolRegistry to update symbols.
        // It assumes the symbol already has an embedding if it was fetched from DB,
        // but if it's new or updated, we might need to re-embed.
        // For now, we'll assume the embedding is handled by the caller or we re-embed if empty.
        
        let embedding_vector = if symbol.embedding.is_empty() {
             let embedding = self
                .embedding_manager
                .embed(&symbol.content)
                .await
                .map_err(|e| StorageError::Embedding(e.to_string()))?;
             Vector::from(embedding)
        } else {
             Vector::from(symbol.embedding.clone())
        };

            sqlx::query(
                r#"
                INSERT INTO symbols (id, path, name, kind, content, embedding_vector, commit_id, start_line, end_line, metadata, created_at, updated_at, embedding_model, embedding_generated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $12)
                ON CONFLICT (id) DO UPDATE
                SET content = $5,
                    embedding_vector = $6,
                    commit_id = $7,
                    start_line = $8,
                    end_line = $9,
                    metadata = $10,
                    updated_at = $12,
                    embedding_generated_at = $12
                "#
            )
            .bind(symbol.id)
            .bind(symbol.path.clone())
            .bind(symbol.name.clone())
            .bind(symbol.kind.clone())
            .bind(symbol.content.clone())
            .bind(embedding_vector)
            .bind(symbol.commit_id.clone())
            .bind(symbol.start_line)
            .bind(symbol.end_line)
            .bind(symbol.metadata.clone())
            .bind(symbol.created_at)
            .bind(symbol.updated_at)
            .bind("all-MiniLM-L6-v2")
            .execute(&self.pool)
            .await?;

        Ok(())
    }
}

pub async fn create_storage(config: StorageConfig) -> Result<Arc<Storage>, StorageError> {
    let storage = Storage::new(config).await?;
    Ok(Arc::new(storage))
}
