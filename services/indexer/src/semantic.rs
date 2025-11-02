use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use twox_hash::xxh3::hash64_with_seed;
use uuid::Uuid;

const EMBEDDING_DIM: usize = 256;
const HASH_SEED: u64 = 0xA11CE_D00D_F005u64;

#[derive(Clone, Default)]
pub struct SemanticStore {
    inner: Arc<RwLock<SemanticIndex>>,
}

#[derive(Default)]
struct SemanticIndex {
    documents: Vec<DocumentRecord>,
    by_path: HashMap<String, Vec<usize>>, // path -> indices into documents
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
        Self::default()
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
        let index = guard.documents.len();
        guard.by_path.entry(request.path).or_default().push(index);
        let document_id = record.id;
        guard.documents.push(record);

        AddDocumentResponse {
            document_id,
            embedding_dim: EMBEDDING_DIM,
        }
    }

    pub fn search(&self, request: SearchRequest) -> Vec<SearchResult> {
        let query_embedding = embed_text(&request.query);
        let guard = self.inner.read();
        let mut results = guard
            .documents
            .iter()
            .enumerate()
            .filter(|(_, record)| match &request.path_prefix {
                Some(prefix) => record.path.starts_with(prefix),
                None => true,
            })
            .filter(|(_, record)| match &request.commit_id {
                Some(commit) => record.commit_id.as_deref() == Some(commit.as_str()),
                None => true,
            })
            .map(|(_, record)| SearchResult {
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
            .filter_map(|&index| guard.documents.get(index))
            .map(|record| HistoryEntry {
                document_id: record.id,
                commit_id: record.commit_id.clone(),
                timestamp: record.timestamp,
            })
            .collect::<Vec<_>>()
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
