use std::env;

use chrono::Utc;
use once_cell::sync::Lazy;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tracing::{event, Level};
use uuid::Uuid;

use crate::request_context::current_request_context;

const SERVICE_NAME: &str = "indexer";

static HASH_SALT: Lazy<String> = Lazy::new(|| {
    let salt = env::var("INDEXER_AUDIT_SALT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            env::var("AUDIT_HASH_SALT")
                .ok()
                .filter(|value| !value.trim().is_empty())
        });

    match salt {
        Some(value) => value,
        None => {
            tracing::warn!(
                target: "audit",
                service = SERVICE_NAME,
                "No audit hash salt configured; generated ephemeral audit hash salt for this process"
            );
            Uuid::new_v4().to_string()
        }
    }
});

static SECRET_KEY_PATTERNS: Lazy<Vec<regex::Regex>> = Lazy::new(|| {
    vec![
        regex::Regex::new("(?i)token").unwrap(),
        regex::Regex::new("(?i)secret").unwrap(),
        regex::Regex::new("(?i)password").unwrap(),
        regex::Regex::new("(?i)credential").unwrap(),
        regex::Regex::new("(?i)authorization").unwrap(),
        regex::Regex::new("(?i)api[_-]?key").unwrap(),
        regex::Regex::new("(?i)client[_-]?secret").unwrap(),
    ]
});

fn hash_identity(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(HASH_SALT.as_bytes());
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn should_mask(key: Option<&str>) -> bool {
    if let Some(key) = key {
        SECRET_KEY_PATTERNS
            .iter()
            .any(|pattern| pattern.is_match(key))
    } else {
        false
    }
}

fn sanitize_value(value: Value, key: Option<&str>) -> Option<Value> {
    match value {
        Value::Null => None,
        Value::String(s) => {
            if should_mask(key) {
                Some(Value::String("[redacted]".to_string()))
            } else if s.is_empty() {
                None
            } else {
                Some(Value::String(s))
            }
        }
        Value::Array(items) => {
            let sanitized: Vec<Value> = items
                .into_iter()
                .filter_map(|item| sanitize_value(item, None))
                .collect();
            if sanitized.is_empty() {
                None
            } else {
                Some(Value::Array(sanitized))
            }
        }
        Value::Object(map) => {
            let sanitized_map = sanitize_map(map);
            if sanitized_map.is_empty() {
                None
            } else {
                Some(Value::Object(sanitized_map))
            }
        }
        other => Some(other),
    }
}

fn sanitize_map(map: Map<String, Value>) -> Map<String, Value> {
    let mut sanitized = Map::new();
    for (key, value) in map.into_iter() {
        if let Some(cleaned) = sanitize_value(value, Some(&key)) {
            sanitized.insert(key, cleaned);
        }
    }
    sanitized
}

fn extract_details(details: Option<Value>) -> (Option<String>, Option<Value>) {
    match details {
        Some(Value::Object(mut map)) => {
            let capability = map
                .remove("capability")
                .and_then(|value| value.as_str().map(|s| s.to_string()));
            let sanitized = sanitize_map(map);
            let details_value = if sanitized.is_empty() {
                None
            } else {
                Some(Value::Object(sanitized))
            };
            (capability, details_value)
        }
        Some(other) => {
            let sanitized = sanitize_value(other, None);
            (None, sanitized)
        }
        None => (None, None),
    }
}

fn map_level(outcome: &str) -> Level {
    match outcome {
        "failure" => Level::ERROR,
        "denied" | "rejected" => Level::WARN,
        _ => Level::INFO,
    }
}

pub fn log_audit(action: &str, outcome: &str, resource: Option<&str>, details: Option<Value>) {
    let (capability, redacted_details) = extract_details(details);
    let details_json = redacted_details
        .map(|value| serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string()))
        .unwrap_or_else(|| "{}".to_string());

    let context = current_request_context();
    let request_id = context.as_ref().map(|ctx| ctx.request_id().to_string());
    let trace_id = context
        .as_ref()
        .and_then(|ctx| ctx.trace_id().map(str::to_string));
    let client_ip = context
        .as_ref()
        .and_then(|ctx| ctx.client_ip().map(|ip| ip.to_string()))
        .unwrap_or_else(|| "anonymous".to_string());
    let actor_id = hash_identity(&client_ip);

    let level = map_level(outcome);
    let timestamp = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let target_resource = resource.unwrap_or("unspecified");
    let request_id_field = request_id.unwrap_or_default();
    let trace_id_field = trace_id.unwrap_or_default();
    let capability_field = capability.unwrap_or_default();

    match level {
        Level::ERROR => event!(
            target: "audit",
            Level::ERROR,
            ts = %timestamp,
            service = SERVICE_NAME,
            event = action,
            outcome = outcome,
            target = target_resource,
            actor_id = %actor_id,
            request_id = %request_id_field,
            trace_id = %trace_id_field,
            capability = %capability_field,
            redacted_details = %details_json
        ),
        Level::WARN => event!(
            target: "audit",
            Level::WARN,
            ts = %timestamp,
            service = SERVICE_NAME,
            event = action,
            outcome = outcome,
            target = target_resource,
            actor_id = %actor_id,
            request_id = %request_id_field,
            trace_id = %trace_id_field,
            capability = %capability_field,
            redacted_details = %details_json
        ),
        _ => event!(
            target: "audit",
            Level::INFO,
            ts = %timestamp,
            service = SERVICE_NAME,
            event = action,
            outcome = outcome,
            target = target_resource,
            actor_id = %actor_id,
            request_id = %request_id_field,
            trace_id = %trace_id_field,
            capability = %capability_field,
            redacted_details = %details_json
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_sensitive_keys() {
        let (_capability, redacted) = extract_details(Some(json!({
            "token": "abc123",
            "nested": {
                "refresh_token": "secret"
            },
            "allowed": true
        })));

        let map = redacted.unwrap().as_object().unwrap().clone();
        assert_eq!(map.get("token").unwrap(), "[redacted]");
        let nested = map
            .get("nested")
            .and_then(|value| value.as_object())
            .unwrap();
        assert_eq!(nested.get("refresh_token").unwrap(), "[redacted]");
        assert_eq!(map.get("allowed").unwrap(), &json!(true));
    }

    #[test]
    fn hash_identity_is_stable() {
        let first = hash_identity("example");
        let second = hash_identity("example");
        assert_eq!(first, second);
    }
}
