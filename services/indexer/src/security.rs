use std::env;
use std::path::{Component, Path, PathBuf};

use once_cell::sync::Lazy;
use regex::Regex;
use thiserror::Error;
use tracing::{info, warn};

const DEFAULT_DLP_PATTERNS: [&str; 7] = [
    // Private keys
    r"-----BEGIN (?:RSA|DSA|EC|PGP) PRIVATE KEY-----",
    // AWS access key IDs
    r"AKIA[0-9A-Z]{16}",
    // Generic secret / password assignments
    r"(?i)secret(?:key)?\s*[:=]\s*[^\s]{16,}",
    r"(?i)password\s*[:=]\s*[^\s]{12,}",
    r"(?i)api[_-]?key\s*[:=]\s*[^\s]{16,}",
    // US Social Security Numbers
    r"\b\d{3}-\d{2}-\d{4}\b",
    // JWT bearer tokens
    r"(?i)bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+",
];

const CREDIT_CARD_PATTERN_LABEL: &str = "credit-card-luhn";
const CREDIT_CARD_PATTERN: &str =
    r"(?xi)
        \b
        (?:
            4\d{3}(?:[\s-]?\d{4}){2}[\s-]?\d{1,4}|
            5[1-5]\d{2}(?:[\s-]?\d{4}){3}|
            2(?:2[2-9]\d|[3-6]\d{2}|7[01]\d|720\d)(?:[\s-]?\d{4}){3}|
            3[47]\d{2}[\s-]?\d{6}[\s-]?\d{5}|
            6(?:011|5\d{2})(?:[\s-]?\d{4}){3}|
            3(?:0[0-5]|[68]\d)\d[\s-]?\d{6}[\s-]?\d{4}|
            35(?:2[89]|[3-8]\d)\d(?:[\s-]?\d{4}){3}
        )
        \b
    ";

static CREDIT_CARD_REGEX: Lazy<Regex> =
    Lazy::new(|| Regex::new(CREDIT_CARD_PATTERN).expect("valid credit card candidate pattern"));

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
    strict_dlp: bool,
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
            .unwrap_or_else(Vec::new);

        let run_mode = env::var("RUN_MODE")
            .map(|value| value.to_lowercase())
            .unwrap_or_else(|_| "consumer".to_string());
        let strict_dlp = run_mode == "enterprise";

        let mut patterns: Vec<Regex> = Vec::new();
        for pattern in DEFAULT_DLP_PATTERNS {
            match Regex::new(pattern) {
                Ok(regex) => patterns.push(regex),
                Err(error) => {
                    if strict_dlp {
                        panic!("Failed to compile built-in DLP pattern '{pattern}': {error}");
                    } else {
                        warn!(
                            pattern = pattern,
                            error = %error,
                            "Failed to compile built-in DLP pattern; skipping"
                        );
                    }
                }
            }
        }

        if let Ok(extra) = env::var("INDEXER_DLP_BLOCK_PATTERNS") {
            let fallback_patterns: Vec<Regex> = extra
                .split(',')
                .map(|entry| entry.trim())
                .filter(|entry| !entry.is_empty())
                .filter_map(|pattern| match Regex::new(pattern) {
                    Ok(regex) => Some(regex),
                    Err(error) => {
                        if strict_dlp {
                            panic!("Failed to compile DLP pattern from INDEXER_DLP_BLOCK_PATTERNS ('{pattern}'): {error}");
                        } else {
                            warn!(
                                pattern = pattern,
                                error = %error,
                                "Failed to compile custom DLP pattern from INDEXER_DLP_BLOCK_PATTERNS; skipping"
                            );
                            None
                        }
                    }
                })
                .collect();

            if fallback_patterns.is_empty() && !strict_dlp {
                warn!(
                    "No valid custom DLP patterns configured via INDEXER_DLP_BLOCK_PATTERNS; using built-in defaults only"
                );
            } else if !fallback_patterns.is_empty() {
                info!(
                    count = fallback_patterns.len(),
                    "Loaded additional DLP patterns from INDEXER_DLP_BLOCK_PATTERNS"
                );
            }
            patterns.extend(fallback_patterns);
        }

        if patterns.is_empty() {
            if strict_dlp {
                panic!("No valid DLP patterns available in enterprise run mode");
            } else {
                warn!("No valid DLP patterns configured; DLP scanning is effectively disabled");
            }
        } else if strict_dlp {
            info!(
                count = patterns.len(),
                "DLP scanning enabled with mandatory patterns (enterprise mode)"
            );
        }

        let (allow_all, normalized_allowed) = normalize_allowed_prefixes(allowed);

        Self {
            allowed_prefixes: normalized_allowed,
            allow_all,
            dlp_patterns: patterns,
            strict_dlp,
        }
    }

    pub fn with_rules(allowed_prefixes: Vec<String>, dlp_patterns: Vec<Regex>) -> Self {
        let (allow_all, normalized_allowed) = normalize_allowed_prefixes(allowed_prefixes);

        Self {
            allowed_prefixes: normalized_allowed,
            allow_all,
            dlp_patterns,
            strict_dlp: false,
        }
    }

    pub fn allow_all(&self) -> bool {
        self.allow_all
    }

    pub fn allowed_prefix_count(&self) -> usize {
        self.allowed_prefixes.len()
    }

    pub fn dlp_pattern_count(&self) -> usize {
        self.dlp_patterns.len()
    }

    pub fn strict_dlp(&self) -> bool {
        self.strict_dlp
    }

    pub fn is_allowed(&self, path: &str) -> bool {
        let normalized = match normalize_path(path) {
            Some(value) => value,
            None => return false,
        };

        if self.allow_all {
            return true;
        }

        if self.allowed_prefixes.is_empty() {
            return false;
        }

        self.allowed_prefixes
            .iter()
            .any(|prefix| normalized.starts_with(prefix))
    }

    pub fn check_path(&self, path: &str) -> Result<(), SecurityError> {
        let normalized =
            normalize_path(path).ok_or_else(|| SecurityError::AclViolation(path.to_string()))?;

        if self.allow_all {
            return Ok(());
        }

        if self.allowed_prefixes.is_empty() {
            return Err(SecurityError::AclViolation(path.to_string()));
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

        if contains_credit_card_candidate(content) {
            return Err(SecurityError::DlpMatch {
                pattern: CREDIT_CARD_PATTERN_LABEL.to_string(),
            });
        }
        Ok(())
    }
}

fn contains_credit_card_candidate(content: &str) -> bool {
    CREDIT_CARD_REGEX
        .find_iter(content)
        .filter_map(|m| {
            let digits: String = m
                .as_str()
                .chars()
                .filter(|ch| ch.is_ascii_digit())
                .collect();

            if (13..=19).contains(&digits.len()) && luhn_check(&digits) {
                Some(())
            } else {
                None
            }
        })
        .next()
        .is_some()
}

fn luhn_check(digits: &str) -> bool {
    let mut sum = 0u32;
    let mut double = false;

    for ch in digits.chars().rev() {
        let mut value = (ch as u8 - b'0') as u32;
        if double {
            value *= 2;
            if value > 9 {
                value -= 9;
            }
        }
        sum += value;
        double = !double;
    }

    sum % 10 == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::panic::{self, AssertUnwindSafe};

    static ENV_LOCK: Lazy<std::sync::Mutex<()>> = Lazy::new(|| std::sync::Mutex::new(()));

    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    struct EnvScope {
        restorers: Vec<(String, Option<String>)>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl EnvScope {
        fn new(set_vars: &[(&str, &str)], unset_vars: &[&str]) -> Self {
            let lock = lock_env();
            let mut restorers = Vec::new();

            for (key, value) in set_vars {
                restorers.push((key.to_string(), env::var(key).ok()));
                env::set_var(key, value);
            }
            for key in unset_vars {
                restorers.push((key.to_string(), env::var(key).ok()));
                env::remove_var(key);
            }

            Self {
                restorers,
                _lock: lock,
            }
        }
    }

    impl Drop for EnvScope {
        fn drop(&mut self) {
            for (key, value) in self.restorers.drain(..) {
                if let Some(original) = value {
                    env::set_var(&key, original);
                } else {
                    env::remove_var(&key);
                }
            }
        }
    }

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
    fn acl_invalid_prefixes_fail_closed() {
        let config = SecurityConfig::with_rules(vec!["../tmp".into(), "C:\\temp".into()], vec![]);

        assert!(!config.is_allowed("src/lib.rs"));
        assert!(matches!(
            config.check_path("src/lib.rs"),
            Err(SecurityError::AclViolation(_))
        ));
    }

    #[test]
    fn from_env_requires_explicit_allowlist() {
        let _scope = EnvScope::new(
            &[],
            &[
                "INDEXER_ACL_ALLOW",
                "RUN_MODE",
                "INDEXER_DLP_BLOCK_PATTERNS",
            ],
        );

        let config = SecurityConfig::from_env();

        assert!(!config.is_allowed("src/lib.rs"));
        assert!(matches!(
            config.check_path("src/lib.rs"),
            Err(SecurityError::AclViolation(_))
        ));
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

    #[test]
    fn dlp_blocks_sensitive_identifiers() {
        let config = SecurityConfig::with_rules(
            vec!["/".into()],
            DEFAULT_DLP_PATTERNS
                .iter()
                .filter_map(|pattern| Regex::new(pattern).ok())
                .collect(),
        );

        for sample in [
            "Customer SSN: 123-45-6789",
            "Card number 4242 4242 4242 4242 exp 10/30",
            "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def",
        ] {
            let err = config.scan_content(sample).unwrap_err();
            assert!(
                matches!(err, SecurityError::DlpMatch { .. }),
                "expected DLP match for sample {sample}"
            );
        }
    }

    #[test]
    fn luhn_filter_ignores_false_positives() {
        let config = SecurityConfig::with_rules(
            vec!["/".into()],
            DEFAULT_DLP_PATTERNS
                .iter()
                .filter_map(|pattern| Regex::new(pattern).ok())
                .collect(),
        );

        let benign_sample = "Order ID: 1111-2222-3333-4445";
        assert!(config.scan_content(benign_sample).is_ok());

        let valid_card = "Refund to 3782-822463-10005"; // American Express test number
        let err = config.scan_content(valid_card).unwrap_err();
        assert!(matches!(err, SecurityError::DlpMatch { .. }));
    }

    #[test]
    fn luhn_helper_detects_known_card() {
        assert!(CREDIT_CARD_REGEX.is_match("4242 4242 4242 4242"));
        assert!(luhn_check("4242424242424242"));
        assert!(contains_credit_card_candidate("4242 4242 4242 4242"));
    }

    #[test]
    fn issuer_prefix_filter_reduces_false_matches() {
        assert!(!CREDIT_CARD_REGEX.is_match("Order ID: 1111-2222-3333-4445"));
        assert!(CREDIT_CARD_REGEX.is_match("Valid Visa: 4242-4242-4242-4242"));
    }

    #[test]
    fn dlp_invalid_pattern_skipped_in_consumer_mode() {
        let _scope = EnvScope::new(
            &[
                ("RUN_MODE", "consumer"),
                ("INDEXER_DLP_BLOCK_PATTERNS", "["),
            ],
            &[],
        );

        let config = SecurityConfig::from_env();
        let err = config
            .scan_content("-----BEGIN RSA PRIVATE KEY-----")
            .unwrap_err();
        assert!(matches!(err, SecurityError::DlpMatch { .. }));
    }

    #[test]
    fn dlp_invalid_pattern_panics_in_enterprise_mode() {
        let result = panic::catch_unwind(AssertUnwindSafe(|| {
            let _scope = EnvScope::new(
                &[
                    ("RUN_MODE", "enterprise"),
                    ("INDEXER_DLP_BLOCK_PATTERNS", "["),
                ],
                &[],
            );
            SecurityConfig::from_env();
        }));
        assert!(
            result.is_err(),
            "expected panic when DLP pattern invalid in enterprise mode"
        );
    }
}
