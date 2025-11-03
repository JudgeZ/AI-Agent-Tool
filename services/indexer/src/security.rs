use std::env;
use std::path::{Component, Path, PathBuf};

use regex::Regex;
use thiserror::Error;

const DEFAULT_ALLOWED_PREFIXES: [&str; 1] = ["/"];
const DEFAULT_DLP_PATTERNS: [&str; 5] = [
    r"-----BEGIN (?:RSA|DSA|EC|PGP) PRIVATE KEY-----",
    r"AKIA[0-9A-Z]{16}",
    r"(?i)secret(?:key)?\s*[:=]\s*[^\s]{16,}",
    r"(?i)password\s*[:=]\s*[^\s]{12,}",
    r"(?i)api[_-]?key\s*[:=]\s*[^\s]{16,}",
];

#[derive(Debug, Error)]
pub enum SecurityError {
    #[error("path '{0}' is not permitted by ACL policy")]
    AclViolation(String),
    #[error("content blocked by DLP pattern: {pattern}")]
    DlpMatch { pattern: String },
}

#[derive(Clone)]
pub struct SecurityConfig {
    allowed_prefixes: Vec<PathBuf>,
    allow_all: bool,
    dlp_patterns: Vec<Regex>,
}

fn normalize_path(path: &str) -> Option<PathBuf> {
    let candidate = Path::new(path);
    let mut normalized = PathBuf::from("/");

    for component in candidate.components() {
        match component {
            Component::RootDir => {
                normalized = PathBuf::from("/");
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
                if normalized.as_os_str().is_empty() {
                    normalized.push("/");
                }
            }
            Component::Normal(segment) => {
                normalized.push(segment);
            }
            Component::Prefix(_) => {
                return None;
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        normalized.push("/");
    }

    Some(normalized)
}

fn normalize_allowed_prefixes(prefixes: Vec<String>) -> (bool, Vec<PathBuf>) {
    let mut allow_all = false;
    let mut normalized = Vec::new();

    for entry in prefixes {
        if entry == "*" {
            allow_all = true;
            continue;
        }

        if let Some(path) = normalize_path(&entry) {
            normalized.push(path);
        }
    }

    (allow_all, normalized)
}

impl SecurityConfig {
    pub fn from_env() -> Self {
        let allowed = env::var("INDEXER_ACL_ALLOW")
            .ok()
            .map(|value| {
                value
                    .split(',')
                    .map(|segment| segment.trim().to_string())
                    .filter(|segment| !segment.is_empty())
                    .collect::<Vec<_>>()
            })
            .filter(|entries| !entries.is_empty())
            .unwrap_or_else(|| {
                DEFAULT_ALLOWED_PREFIXES
                    .iter()
                    .map(|s| s.to_string())
                    .collect()
            });

        let mut patterns: Vec<Regex> = DEFAULT_DLP_PATTERNS
            .iter()
            .filter_map(|pattern| Regex::new(pattern).ok())
            .collect();

        if let Ok(extra) = env::var("INDEXER_DLP_BLOCK_PATTERNS") {
            for pattern in extra
                .split(',')
                .map(|entry| entry.trim())
                .filter(|entry| !entry.is_empty())
            {
                if let Ok(regex) = Regex::new(pattern) {
                    patterns.push(regex);
                }
            }
        }

        let (allow_all, normalized_allowed) = normalize_allowed_prefixes(allowed);

        Self {
            allowed_prefixes: normalized_allowed,
            allow_all,
            dlp_patterns: patterns,
        }
    }

    pub fn with_rules(allowed_prefixes: Vec<String>, dlp_patterns: Vec<Regex>) -> Self {
        let (allow_all, normalized_allowed) = normalize_allowed_prefixes(allowed_prefixes);

        Self {
            allowed_prefixes: normalized_allowed,
            allow_all,
            dlp_patterns,
        }
    }

    pub fn is_allowed(&self, path: &str) -> bool {
        let normalized = match normalize_path(path) {
            Some(value) => value,
            None => return false,
        };

        if self.allow_all || self.allowed_prefixes.is_empty() {
            return true;
        }

        self.allowed_prefixes
            .iter()
            .any(|prefix| normalized.starts_with(prefix))
    }

    pub fn check_path(&self, path: &str) -> Result<(), SecurityError> {
        let normalized =
            normalize_path(path).ok_or_else(|| SecurityError::AclViolation(path.to_string()))?;

        if self.allow_all || self.allowed_prefixes.is_empty() {
            return Ok(());
        }

        if self
            .allowed_prefixes
            .iter()
            .any(|prefix| normalized.starts_with(prefix))
        {
            Ok(())
        } else {
            Err(SecurityError::AclViolation(path.to_string()))
        }
    }

    pub fn scan_content(&self, content: &str) -> Result<(), SecurityError> {
        for pattern in &self.dlp_patterns {
            if pattern.is_match(content) {
                return Err(SecurityError::DlpMatch {
                    pattern: pattern.as_str().to_string(),
                });
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acl_allows_prefixes() {
        let config = SecurityConfig::with_rules(vec!["src/".into()], vec![]);
        assert!(config.is_allowed("src/lib.rs"));
        assert!(config.is_allowed("/src/lib.rs"));
        assert!(!config.is_allowed("docs/guide.md"));
    }

    #[test]
    fn acl_blocks_path_traversal_attempts() {
        let config = SecurityConfig::with_rules(vec!["src".into()], vec![]);

        assert!(!config.is_allowed("../etc/passwd"));
        assert!(!config.is_allowed("src/../secrets.txt"));
        assert!(config.is_allowed("src/module/lib.rs"));

        let err = config.check_path("src/../../etc/passwd").unwrap_err();
        assert!(matches!(err, SecurityError::AclViolation(_)));
    }

    #[test]
    fn dlp_blocks_default_patterns() {
        let config = SecurityConfig::with_rules(
            vec!["/".into()],
            DEFAULT_DLP_PATTERNS
                .iter()
                .filter_map(|pattern| Regex::new(pattern).ok())
                .collect(),
        );
        let err = config
            .scan_content("-----BEGIN RSA PRIVATE KEY-----")
            .unwrap_err();
        assert!(matches!(err, SecurityError::DlpMatch { .. }));
    }
}
