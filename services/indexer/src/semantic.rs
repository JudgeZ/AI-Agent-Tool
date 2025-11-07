use std::collections::{HashMap, VecDeque};
use std::env;
use std::mem::size_of;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tracing::warn;
use twox_hash::xxh3::hash64_with_seed;
use uuid::Uuid;

const EMBEDDING_DIM: usize = 256;
const HASH_SEED: u64 = 0xA11CE_D00D_F005u64;
const DEFAULT_MAX_DOCUMENTS: usize = 10_000;

#[derive(Clone, Debug)]
pub struct SemanticConfig {
    pub max_documents: Option<usize>,
}

impl Default for SemanticConfig {
    fn default() -> Self {
        Self {
            max_documents: Some(DEFAULT_MAX_DOCUMENTS),
        }
    }
}

impl SemanticConfig {
    const MAX_DOCS_ENV: &'static str = "SEMANTIC_STORE_MAX_DOCUMENTS";

    pub fn from_env() -> Self {
        let mut config = Self::default();
        if let Ok(value) = env::var(Self::MAX_DOCS_ENV) {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return config;
            }

            match trimmed.parse::<usize>() {
                Ok(0) => config.max_documents = None,
                Ok(parsed) => config.max_documents = Some(parsed),
                Err(error) => {
                    warn!(
                        "failed to parse {}='{}': {} — using default",
                        Self::MAX_DOCS_ENV,
                        trimmed,
                        error
                    );
                }
            }
        }
        config
    }
}

#[derive(Clone, Default)]
pub struct SemanticStore {
    inner: Arc<RwLock<SemanticIndex>>,
    config: Arc<SemanticConfig>,
}

#[derive(Default)]
struct SemanticIndex {
    order: VecDeque<Uuid>,
    records: HashMap<Uuid, DocumentRecord>,
    by_path: HashMap<String, Vec<Uuid>>, // path -> document ids
}

#[derive(Clone, Debug)]
struct DocumentRecord {
    id: Uuid,
    path: String,
    content: String,
    embedding: Vec<f32>,
    commit_id: Option<String>,
    timestamp: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct AddDocumentRequest {
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub commit_id: Option<String>,
    #[serde(default)]
    pub timestamp: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct AddDocumentResponse {
    pub document_id: Uuid,
    pub embedding_dim: usize,
}

#[derive(Debug, Deserialize)]
pub struct SearchRequest {
    pub query: String,
    #[serde(default = "default_top_k")]
    pub top_k: usize,
    #[serde(default)]
    pub path_prefix: Option<String>,
    #[serde(default)]
    pub commit_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub document_id: Uuid,
    pub path: String,
    pub score: f32,
    pub snippet: String,
    pub commit_id: Option<String>,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct HistoryEntry {
    pub document_id: Uuid,
    pub commit_id: Option<String>,
    pub timestamp: DateTime<Utc>,
}

impl SemanticStore {
    pub fn new() -> Self {
        Self::from_config(SemanticConfig::from_env())
    }

    pub fn from_config(config: SemanticConfig) -> Self {
        Self {
            inner: Arc::new(RwLock::new(SemanticIndex::default())),
            config: Arc::new(config),
        }
    }

    pub fn add_document(&self, request: AddDocumentRequest) -> AddDocumentResponse {
        let embedding = embed_text(&request.content);
        let record = DocumentRecord {
            id: Uuid::new_v4(),
            path: request.path.clone(),
            content: request.content,
            embedding,
            commit_id: request.commit_id,
            timestamp: request.timestamp.unwrap_or_else(Utc::now),
        };

        let mut guard = self.inner.write();
        let document_id = record.id;
        let path = record.path.clone();
        guard.order.push_back(document_id);
        guard.by_path.entry(path).or_default().push(document_id);
        guard.records.insert(document_id, record);
        guard.evict_if_needed(&self.config);

        AddDocumentResponse {
            document_id,
            embedding_dim: EMBEDDING_DIM,
        }
    }

    pub fn search(&self, request: SearchRequest) -> Vec<SearchResult> {
        let query_embedding = embed_text(&request.query);
        let guard = self.inner.read();
        let mut results = guard
            .records
            .values()
            .filter(|record| match &request.path_prefix {
                Some(prefix) => record.path.starts_with(prefix),
                None => true,
            })
            .filter(|record| match &request.commit_id {
                Some(commit) => record.commit_id.as_deref() == Some(commit.as_str()),
                None => true,
            })
            .map(|record| SearchResult {
                document_id: record.id,
                path: record.path.clone(),
                score: cosine_similarity(&query_embedding, &record.embedding),
                snippet: snippet(&record.content),
                commit_id: record.commit_id.clone(),
                timestamp: record.timestamp,
            })
            .collect::<Vec<_>>();

        results.sort_by(|a, b| b.score.total_cmp(&a.score));
        results.truncate(request.top_k);
        results
    }

    pub fn history_for_path(&self, path: &str) -> Vec<HistoryEntry> {
        let guard = self.inner.read();
        guard
            .by_path
            .get(path)
            .into_iter()
            .flatten()
            .filter_map(|&id| guard.records.get(&id))
            .map(|record| HistoryEntry {
                document_id: record.id,
                commit_id: record.commit_id.clone(),
                timestamp: record.timestamp,
            })
            .collect::<Vec<_>>()
    }

    pub fn stats(&self) -> SemanticStats {
        let guard = self.inner.read();
        guard.stats()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SemanticStats {
    pub document_count: usize,
    pub approx_bytes: usize,
}

impl SemanticIndex {
    fn evict_if_needed(&mut self, config: &SemanticConfig) {
        if let Some(max_documents) = config.max_documents {
            while self.order.len() > max_documents {
                if let Some(evicted_id) = self.order.pop_front() {
                    self.remove_document(evicted_id);
                }
            }
        }
    }

    fn remove_document(&mut self, id: Uuid) {
        if let Some(record) = self.records.remove(&id) {
            if let Some(entries) = self.by_path.get_mut(&record.path) {
                entries.retain(|entry| *entry != id);
                if entries.is_empty() {
                    self.by_path.remove(&record.path);
                }
            }
        }
    }

    fn stats(&self) -> SemanticStats {
        let approx_bytes = self
            .records
            .values()
            .map(|record| {
                record.content.len()
                    + record.path.len()
                    + record
                        .commit_id
                        .as_ref()
                        .map(|commit| commit.len())
                        .unwrap_or_default()
                    + record.embedding.len() * size_of::<f32>()
                    + size_of::<Uuid>()
                    + size_of::<DateTime<Utc>>()
            })
            .sum();

        SemanticStats {
            document_count: self.records.len(),
            approx_bytes,
        }
    }
}

fn embed_text(text: &str) -> Vec<f32> {
    let mut vector = vec![0.0f32; EMBEDDING_DIM];
    if text.trim().is_empty() {
        return vector;
    }

    let tokens = tokenize(text);
    for token in tokens {
        let hash = hash64_with_seed(token.as_bytes(), HASH_SEED);
        let bucket = (hash as usize) % EMBEDDING_DIM;
        let magnitude = (hash as f32 % 997.0) / 997.0;
        vector[bucket] += magnitude;
    }

    normalize(&mut vector);
    vector
}

fn tokenize(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|token| !token.is_empty())
        .map(|token| token.to_lowercase())
}

fn normalize(vector: &mut [f32]) {
    let sum_sq: f32 = vector.iter().map(|v| v * v).sum();
    if sum_sq == 0.0 {
        return;
    }
    let len = sum_sq.sqrt();
    for value in vector.iter_mut() {
        *value /= len;
    }
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    dot.clamp(-1.0, 1.0)
}

fn snippet(content: &str) -> String {
    let trimmed = content.trim();
    if trimmed.len() <= 160 {
        return trimmed.to_string();
    }
    let head = trimmed.chars().take(157).collect::<String>();
    format!("{head}…")
}

fn default_top_k() -> usize {
    5
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evicts_oldest_documents_when_over_capacity() {
        let store = SemanticStore::from_config(SemanticConfig {
            max_documents: Some(2),
        });

        store.add_document(AddDocumentRequest {
            path: "src/lib.rs".into(),
            content: "fn one() {}".into(),
            commit_id: Some("commit-1".into()),
            timestamp: None,
        });
        store.add_document(AddDocumentRequest {
            path: "src/lib.rs".into(),
            content: "fn two() {}".into(),
            commit_id: Some("commit-2".into()),
            timestamp: None,
        });

        let before_stats = store.stats();
        assert_eq!(before_stats.document_count, 2);

        store.add_document(AddDocumentRequest {
            path: "src/lib.rs".into(),
            content: "fn three() {}".into(),
            commit_id: Some("commit-3".into()),
            timestamp: None,
        });

        let history = store.history_for_path("src/lib.rs");
        let commit_ids: Vec<_> = history
            .iter()
            .filter_map(|entry| entry.commit_id.as_deref())
            .collect();
        assert_eq!(commit_ids, vec!["commit-2", "commit-3"]);

        let after_stats = store.stats();
        assert_eq!(after_stats.document_count, 2);
        assert!(after_stats.approx_bytes <= before_stats.approx_bytes + 128);
    }

    #[test]
    fn memory_usage_remains_stable_under_load() {
        let store = SemanticStore::from_config(SemanticConfig {
            max_documents: Some(3),
        });

        for i in 0..3 {
            store.add_document(AddDocumentRequest {
                path: "src/main.rs".into(),
                content: "pub fn handler() {}".into(),
                commit_id: Some(format!("c{:02}", i)),
                timestamp: None,
            });
        }

        let baseline = store.stats();
        assert_eq!(baseline.document_count, 3);

        for i in 3..30 {
            store.add_document(AddDocumentRequest {
                path: "src/main.rs".into(),
                content: "pub fn handler() {}".into(),
                commit_id: Some(format!("c{:02}", i % 100)),
                timestamp: None,
            });
        }

        let stats = store.stats();
        assert_eq!(stats.document_count, 3);
        assert!(stats.approx_bytes <= baseline.approx_bytes + 256);
    }

    #[test]
    fn adds_and_searches_documents() {
        let store = SemanticStore::new();
        store.add_document(AddDocumentRequest {
            path: "src/lib.rs".into(),
            content: "fn hello_world() { println!(\"hello\"); }".into(),
            commit_id: Some("abc123".into()),
            timestamp: None,
        });
        store.add_document(AddDocumentRequest {
            path: "src/lib.rs".into(),
            content: "fn goodbye() { println!(\"bye\"); }".into(),
            commit_id: Some("def456".into()),
            timestamp: None,
        });

        let results = store.search(SearchRequest {
            query: "hello".into(),
            top_k: 3,
            path_prefix: None,
            commit_id: None,
        });

        assert!(!results.is_empty());
        assert!(results[0].path.ends_with("src/lib.rs"));
    }

    #[test]
    fn history_returns_commit_sequence() {
        let store = SemanticStore::new();
        let commit_a = "a".to_string();
        let commit_b = "b".to_string();
        store.add_document(AddDocumentRequest {
            path: "file.txt".into(),
            content: "first".into(),
            commit_id: Some(commit_a.clone()),
            timestamp: Some(Utc::now()),
        });
        store.add_document(AddDocumentRequest {
            path: "file.txt".into(),
            content: "second".into(),
            commit_id: Some(commit_b.clone()),
            timestamp: Some(Utc::now()),
        });

        let history = store.history_for_path("file.txt");
        assert_eq!(history.len(), 2);
        assert!(history
            .iter()
            .any(|entry| entry.commit_id.as_deref() == Some(commit_a.as_str())));
        assert!(history
            .iter()
            .any(|entry| entry.commit_id.as_deref() == Some(commit_b.as_str())));
    }
}
