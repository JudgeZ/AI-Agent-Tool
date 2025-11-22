#![allow(dead_code)]

use chrono::{DateTime, Utc};
use git2::{Commit, DiffOptions, Oid, Repository};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use thiserror::Error;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use super::symbol_extractor;
use crate::storage::{IndexStorage, StoredSymbol};

/// Error types for temporal operations
#[derive(Error, Debug)]
pub enum TemporalError {
    #[error("Git error: {0}")]
    Git(#[from] git2::Error),

    #[error("Storage error: {0}")]
    Storage(String),

    #[error("Repository not found: {0}")]
    RepositoryNotFound(String),

    #[error("Commit not found: {0}")]
    CommitNotFound(String),

    #[error("Invalid path: {0}")]
    InvalidPath(String),

    #[error("Parse error: {0}")]
    ParseError(String),

    #[error("Task join error: {0}")]
    JoinError(#[from] tokio::task::JoinError),
}

/// Type of change made to a symbol
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ChangeType {
    Added,
    Modified,
    Deleted,
    Renamed,
}

/// A version of a symbol at a specific commit
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolVersion {
    pub symbol_id: Uuid,
    pub commit_id: String,
    pub timestamp: DateTime<Utc>,
    pub change_type: ChangeType,
    pub author: String,
    pub commit_message: String,
    pub symbol: Option<StoredSymbol>,
    pub previous_path: Option<String>, // For renames
}

/// Information about a CI/CD event correlated with code changes
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CiEvent {
    pub test_name: String,
    pub status: CiStatus,
    pub commit_id: String,
    pub timestamp: DateTime<Utc>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum CiStatus {
    Passed,
    Failed,
    Skipped,
}

/// A suspect change that may have caused a CI failure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuspectChange {
    pub symbol: StoredSymbol,
    pub relevance_score: f32,
    pub reason: String,
    pub change_type: ChangeType,
}

/// Configuration for temporal indexing
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TemporalConfig {
    /// Path to the git repository
    pub repo_path: PathBuf,

    /// Maximum number of commits to index in one batch
    pub batch_size: usize,

    /// Maximum age of commits to index (in days)
    pub max_age_days: Option<u32>,

    /// Whether to index merge commits
    pub include_merge_commits: bool,
}

impl Default for TemporalConfig {
    fn default() -> Self {
        Self {
            repo_path: PathBuf::from("."),
            batch_size: 100,
            max_age_days: Some(90), // 3 months
            include_merge_commits: false,
        }
    }
}

impl TemporalConfig {
    pub fn from_env() -> Self {
        let repo_path = std::env::var("GIT_REPO_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."));

        let batch_size = std::env::var("TEMPORAL_BATCH_SIZE")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(100);

        let max_age_days = std::env::var("TEMPORAL_MAX_AGE_DAYS")
            .ok()
            .and_then(|v| v.parse().ok())
            .or(Some(90));

        Self {
            repo_path,
            batch_size,
            max_age_days,
            include_merge_commits: false,
        }
    }
}

/// Temporal index for tracking symbol changes over time
pub struct TemporalIndex {
    #[allow(dead_code)]
    storage: Arc<dyn IndexStorage>,
    config: TemporalConfig,
    symbol_history: Arc<parking_lot::RwLock<HashMap<String, Vec<SymbolVersion>>>>,
    ci_events: Arc<parking_lot::RwLock<Vec<CiEvent>>>,
}

impl TemporalIndex {
    /// Create a new temporal index
    pub fn new(
        config: TemporalConfig,
        storage: Arc<dyn IndexStorage>,
    ) -> Result<Self, TemporalError> {
        // Verify repo exists
        let _ = Repository::open(&config.repo_path).map_err(|e| {
            error!(
                "Failed to open git repository at {:?}: {}",
                config.repo_path, e
            );
            TemporalError::RepositoryNotFound(config.repo_path.display().to_string())
        })?;

        info!("Opened git repository at {:?}", config.repo_path);

        Ok(Self {
            storage,
            config,
            symbol_history: Arc::new(parking_lot::RwLock::new(HashMap::new())),
            ci_events: Arc::new(parking_lot::RwLock::new(Vec::new())),
        })
    }

    /// Index a range of commits
    pub async fn index_commit_range(
        &self,
        start_commit: Option<String>,
        end_commit: Option<String>,
    ) -> Result<usize, TemporalError> {
        let config = self.config.clone();
        let history = self.symbol_history.clone();

        tokio::task::spawn_blocking(move || {
            let repo = Repository::open(&config.repo_path)?;
            let mut revwalk = repo.revwalk()?;

            // Configure the walk
            if let Some(end) = end_commit {
                let oid = Oid::from_str(&end)?;
                revwalk.push(oid)?;
            } else {
                revwalk.push_head()?;
            }

            if let Some(start) = start_commit {
                let oid = Oid::from_str(&start)?;
                revwalk.hide(oid)?;
            }

            // Optionally filter out merge commits
            if !config.include_merge_commits {
                revwalk.simplify_first_parent()?;
            }

            let mut indexed_count = 0;
            let mut batch = Vec::new();

            for oid in revwalk {
                let oid = oid?;
                let commit = repo.find_commit(oid)?;

                // Check age filter
                if let Some(max_age_days) = config.max_age_days {
                    let commit_time = DateTime::from_timestamp(commit.time().seconds(), 0)
                        .ok_or_else(|| {
                            TemporalError::ParseError("Invalid commit timestamp".to_string())
                        })?;
                    let age_days = (Utc::now() - commit_time).num_days();

                    if age_days > max_age_days as i64 {
                        debug!("Skipping commit {} (too old: {} days)", oid, age_days);
                        continue;
                    }
                }

                batch.push(commit);

                if batch.len() >= config.batch_size {
                    indexed_count += process_commit_batch(&repo, &batch, &history)?;
                    batch.clear();
                }
            }

            // Process remaining commits
            if !batch.is_empty() {
                indexed_count += process_commit_batch(&repo, &batch, &history)?;
            }

            info!("Indexed {} commits", indexed_count);
            Ok(indexed_count)
        })
        .await?
    }

    /// Get symbol at a specific commit
    pub async fn get_symbol_at_commit(
        &self,
        path: &str,
        commit_id: &str,
    ) -> Result<Option<StoredSymbol>, TemporalError> {
        let config = self.config.clone();
        let path = path.to_string();
        let commit_id = commit_id.to_string();

        tokio::task::spawn_blocking(move || {
            let repo = Repository::open(&config.repo_path)?;
            let oid = Oid::from_str(&commit_id)?;
            let commit = repo.find_commit(oid)?;
            let tree = commit.tree()?;

            // Try to get the file from the tree
            let entry = match tree.get_path(Path::new(&path)) {
                Ok(e) => e,
                Err(_) => return Ok(None),
            };

            let object = entry.to_object(&repo)?;

            if let Some(blob) = object.as_blob() {
                let content = String::from_utf8_lossy(blob.content()).to_string();

                // Determine language from extension
                let language = if path.ends_with(".rs") {
                    "rust"
                } else if path.ends_with(".ts") || path.ends_with(".tsx") {
                    "typescript"
                } else if path.ends_with(".js") || path.ends_with(".jsx") {
                    "javascript"
                } else {
                    "unknown"
                };

                // Extract symbols
                let extracted = if language != "unknown" {
                    symbol_extractor::extract_symbols(&content, language).unwrap_or_default()
                } else {
                    Vec::new()
                };

                let symbol = StoredSymbol {
                    id: Uuid::new_v4(),
                    path: path.to_string(),
                    name: Path::new(&path)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string(),
                    kind: "File".to_string(),
                    content: content.clone(),
                    embedding: Vec::new(), // No embedding for now
                    commit_id: Some(commit_id.to_string()),
                    start_line: 0,
                    end_line: content.lines().count() as i32,
                    metadata: Some(serde_json::json!({
                        "extracted_symbols_count": extracted.len(),
                        "extracted_symbols": extracted.iter().map(|s| &s.name).collect::<Vec<_>>(),
                        "language": language
                    })),
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                };

                debug!(
                    "Retrieved file {} at commit {} with {} symbols",
                    path,
                    commit_id,
                    extracted.len()
                );

                Ok(Some(symbol))
            } else {
                Ok(None)
            }
        })
        .await?
    }

    /// Get history of changes for a symbol/file
    pub fn get_symbol_history(&self, path: &str) -> Vec<SymbolVersion> {
        let history = self.symbol_history.read();
        history.get(path).cloned().unwrap_or_default()
    }

    /// Correlate a CI/CD failure with recent code changes
    pub async fn correlate_ci_failure(
        &self,
        test_name: &str,
        failure_message: &str,
        commit_id: &str,
        previous_commit_id: Option<&str>,
    ) -> Result<Vec<SuspectChange>, TemporalError> {
        let config = self.config.clone();
        let test_name = test_name.to_string();
        let failure_message = failure_message.to_string();
        let commit_id = commit_id.to_string();
        let previous_commit_id = previous_commit_id.map(|s| s.to_string());

        // We need to call get_symbol_at_commit inside, which is async.
        // But we are inside spawn_blocking, so we can't await easily unless we use a runtime.
        // However, get_symbol_at_commit logic is blocking git ops.
        // So we can duplicate the logic or extract it.
        // Let's extract the logic to a private helper.

        tokio::task::spawn_blocking(move || {
            let repo = Repository::open(&config.repo_path)?;
            debug!(
                "Correlating CI failure for test {} at commit {}",
                test_name, commit_id
            );

            let mut suspects = Vec::new();

            // Get the commit range
            let current_oid = Oid::from_str(&commit_id)?;
            let current_commit = repo.find_commit(current_oid)?;

            if let Some(prev_id) = previous_commit_id {
                let prev_oid = Oid::from_str(&prev_id)?;
                let prev_commit = repo.find_commit(prev_oid)?;

                // Diff between the two commits
                let current_tree = current_commit.tree()?;
                let prev_tree = prev_commit.tree()?;

                let mut diff_opts = DiffOptions::new();
                let diff = repo.diff_tree_to_tree(
                    Some(&prev_tree),
                    Some(&current_tree),
                    Some(&mut diff_opts),
                )?;

                // Analyze changed files
                let mut changed_paths = Vec::new();
                diff.foreach(
                    &mut |delta, _progress| {
                        if let Some(path) = delta.new_file().path() {
                            changed_paths.push((path.display().to_string(), delta.status()));
                        }
                        true
                    },
                    None,
                    None,
                    None,
                )?;

                for (path_str, status) in changed_paths {
                    let relevance_score =
                        calculate_relevance(&path_str, &test_name, &failure_message);

                    if relevance_score > 0.3 {
                        // Get symbol (file content)
                        // We use the blocking logic directly here
                        if let Ok(Some(symbol)) =
                            get_symbol_at_commit_blocking(&repo, &path_str, &commit_id)
                        {
                            let reason = format!(
                                "File {} was modified and may be related to test {}",
                                path_str, test_name
                            );

                            let change_type = match status {
                                git2::Delta::Added => ChangeType::Added,
                                git2::Delta::Modified => ChangeType::Modified,
                                git2::Delta::Deleted => ChangeType::Deleted,
                                git2::Delta::Renamed => ChangeType::Renamed,
                                _ => ChangeType::Modified,
                            };

                            debug!("Suspect change: {} (score: {})", path_str, relevance_score);

                            suspects.push(SuspectChange {
                                symbol,
                                relevance_score,
                                reason,
                                change_type,
                            });
                        }
                    }
                }
            }

            // Sort by relevance score
            suspects.sort_by(|a: &SuspectChange, b| {
                b.relevance_score.partial_cmp(&a.relevance_score).unwrap()
            });

            Ok(suspects)
        })
        .await?
    }

    /// Record a CI/CD event
    pub fn record_ci_event(&self, event: CiEvent) {
        let mut events = self.ci_events.write();
        events.push(event);

        // Keep only recent events (last 1000)
        if events.len() > 1000 {
            let drain_count = events.len() - 1000;
            events.drain(0..drain_count);
        }
    }

    /// Get CI events for a commit
    pub fn get_ci_events_for_commit(&self, commit_id: &str) -> Vec<CiEvent> {
        let events = self.ci_events.read();
        events
            .iter()
            .filter(|e| e.commit_id == commit_id)
            .cloned()
            .collect()
    }

    /// Perform blame analysis for a file
    pub async fn blame(&self, path: &str) -> Result<HashMap<usize, String>, TemporalError> {
        let config = self.config.clone();
        let path = path.to_string();

        tokio::task::spawn_blocking(move || {
            let repo = Repository::open(&config.repo_path)?;
            let blame = repo.blame_file(Path::new(&path), None)?;
            let mut line_authors = HashMap::new();

            for i in 0..blame.len() {
                if let Some(hunk) = blame.get_index(i) {
                    if let Ok(commit) = repo.find_commit(hunk.final_commit_id()) {
                        let author = commit.author().name().unwrap_or("unknown").to_string();
                        let start_line = hunk.final_start_line();
                        let lines = hunk.lines_in_hunk();

                        for line in start_line..(start_line + lines) {
                            line_authors.insert(line, author.clone());
                        }
                    }
                }
            }

            Ok(line_authors)
        })
        .await?
    }
}

// Helper functions

fn process_commit_batch(
    repo: &Repository,
    commits: &[Commit<'_>],
    history: &Arc<parking_lot::RwLock<HashMap<String, Vec<SymbolVersion>>>>,
) -> Result<usize, TemporalError> {
    let mut count = 0;

    for commit in commits {
        if let Err(e) = process_commit(repo, commit, history) {
            warn!("Failed to process commit {}: {}", commit.id(), e);
            continue;
        }
        count += 1;
    }

    Ok(count)
}

fn process_commit(
    repo: &Repository,
    commit: &Commit<'_>,
    history: &Arc<parking_lot::RwLock<HashMap<String, Vec<SymbolVersion>>>>,
) -> Result<(), TemporalError> {
    let commit_id = commit.id().to_string();
    let timestamp = DateTime::from_timestamp(commit.time().seconds(), 0)
        .ok_or_else(|| TemporalError::ParseError("Invalid commit timestamp".to_string()))?;
    let author = commit.author().name().unwrap_or("unknown").to_string();
    let message = commit.message().unwrap_or("").to_string();

    debug!(
        "Processing commit {} by {} at {}",
        commit_id, author, timestamp
    );

    // Get the tree for this commit
    let tree = commit.tree()?;

    // If there's a parent, diff against it
    if commit.parent_count() > 0 {
        let parent = commit.parent(0)?;
        let parent_tree = parent.tree()?;

        let mut diff_opts = DiffOptions::new();
        let diff = repo.diff_tree_to_tree(Some(&parent_tree), Some(&tree), Some(&mut diff_opts))?;

        // Analyze each changed file
        diff.foreach(
            &mut |delta, _progress| {
                let new_file = delta.new_file();
                let old_file = delta.old_file();

                let path = new_file.path().or_else(|| old_file.path());

                if let Some(path) = path {
                    let change_type = match delta.status() {
                        git2::Delta::Added => ChangeType::Added,
                        git2::Delta::Modified => ChangeType::Modified,
                        git2::Delta::Deleted => ChangeType::Deleted,
                        git2::Delta::Renamed => ChangeType::Renamed,
                        _ => return true, // Skip other types
                    };

                    // Record symbol version
                    let version = SymbolVersion {
                        symbol_id: Uuid::new_v4(), // TODO: Link to actual symbol
                        commit_id: commit_id.clone(),
                        timestamp,
                        change_type,
                        author: author.clone(),
                        commit_message: message.clone(),
                        symbol: None, // TODO: Extract symbol from file
                        previous_path: if change_type == ChangeType::Renamed {
                            old_file.path().map(|p| p.display().to_string())
                        } else {
                            None
                        },
                    };

                    // Store in history
                    let path_str = path.display().to_string();
                    let mut history = history.write();
                    history.entry(path_str).or_default().push(version);
                }

                true
            },
            None,
            None,
            None,
        )?;
    }

    Ok(())
}

fn get_symbol_at_commit_blocking(
    repo: &Repository,
    path: &str,
    commit_id: &str,
) -> Result<Option<StoredSymbol>, TemporalError> {
    let oid = Oid::from_str(commit_id)?;
    let commit = repo.find_commit(oid)?;
    let tree = commit.tree()?;

    // Try to get the file from the tree
    let entry = match tree.get_path(Path::new(path)) {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };

    let object = entry.to_object(repo)?;

    if let Some(blob) = object.as_blob() {
        let content = String::from_utf8_lossy(blob.content()).to_string();

        // Determine language from extension
        let language = if path.ends_with(".rs") {
            "rust"
        } else if path.ends_with(".ts") || path.ends_with(".tsx") {
            "typescript"
        } else if path.ends_with(".js") || path.ends_with(".jsx") {
            "javascript"
        } else {
            "unknown"
        };

        // Extract symbols
        let extracted = if language != "unknown" {
            symbol_extractor::extract_symbols(&content, language).unwrap_or_default()
        } else {
            Vec::new()
        };

        let symbol = StoredSymbol {
            id: Uuid::new_v4(),
            path: path.to_string(),
            name: Path::new(path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
            kind: "File".to_string(),
            content: content.clone(),
            embedding: Vec::new(), // No embedding for now
            commit_id: Some(commit_id.to_string()),
            start_line: 0,
            end_line: content.lines().count() as i32,
            metadata: Some(serde_json::json!({
                "extracted_symbols_count": extracted.len(),
                "extracted_symbols": extracted.iter().map(|s| &s.name).collect::<Vec<_>>(),
                "language": language
            })),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        Ok(Some(symbol))
    } else {
        Ok(None)
    }
}

fn calculate_relevance(file_path: &str, test_name: &str, failure_message: &str) -> f32 {
    let mut score: f32 = 0.0;

    // Check if file path contains test name keywords
    let test_parts: Vec<&str> = test_name.split(|c: char| !c.is_alphanumeric()).collect();
    for part in &test_parts {
        if !part.is_empty() && file_path.to_lowercase().contains(&part.to_lowercase()) {
            score += 0.3;
        }
    }

    // Check if failure message mentions the file
    if failure_message.contains(file_path) {
        score += 0.5;
    }

    // Check file extension relevance (e.g., test files)
    if file_path.contains("test") || file_path.contains("spec") {
        score += 0.2;
    }

    score.min(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_change_type_serialization() {
        let ct = ChangeType::Modified;
        let json = serde_json::to_string(&ct).unwrap();
        let deserialized: ChangeType = serde_json::from_str(&json).unwrap();
        assert_eq!(ct, deserialized);
    }

    #[test]
    fn test_ci_status_serialization() {
        let status = CiStatus::Failed;
        let json = serde_json::to_string(&status).unwrap();
        let deserialized: CiStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(status, deserialized);
    }

    #[test]
    fn test_relevance_calculation() {
        // Test with matching file path
        let score1 = calculate_relevance("src/foo.rs", "test_foo", "error");
        assert!(score1 > 0.0);

        // Test with matching failure message
        let score2 = calculate_relevance("src/bar.rs", "test_baz", "error in src/bar.rs");
        assert!(score2 > 0.0);
    }
}
