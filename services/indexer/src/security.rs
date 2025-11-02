use std::env;

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
    allowed_prefixes: Vec<String>,
    dlp_patterns: Vec<Regex>,
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

        Self {
            allowed_prefixes: allowed,
            dlp_patterns: patterns,
        }
    }

    pub fn with_rules(allowed_prefixes: Vec<String>, dlp_patterns: Vec<Regex>) -> Self {
        Self {
            allowed_prefixes,
            dlp_patterns,
        }
    }

    pub fn is_allowed(&self, path: &str) -> bool {
        if self.allowed_prefixes.is_empty() {
            return true;
        }
        let normalized = if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{}", path)
        };
        self.allowed_prefixes.iter().any(|prefix| {
            if prefix == "/" || prefix == "*" {
                true
            } else if normalized.starts_with(prefix) {
                true
            } else if let Some(without_slash) = normalized.strip_prefix('/') {
                without_slash.starts_with(prefix.trim_start_matches('/'))
            } else {
                false
            }
        })
    }

    pub fn check_path(&self, path: &str) -> Result<(), SecurityError> {
        if self.is_allowed(path) {
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
        assert!(!config.is_allowed("docs/guide.md"));
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
        matches!(err, SecurityError::DlpMatch { .. });
    }
}
