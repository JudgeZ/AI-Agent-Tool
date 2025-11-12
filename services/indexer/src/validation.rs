use std::fmt::Display;

use serde::de::{self, Deserializer};
use serde::Deserialize;

const MAX_PATH_LENGTH: usize = 4 * 1024;
const MAX_QUERY_LENGTH: usize = 8 * 1024;

fn ensure_not_blank<'a, T, E>(value: &'a str, field: T) -> Result<&'a str, E>
where
    T: Display,
    E: de::Error,
{
    if value.trim().is_empty() {
        Err(de::Error::custom(format!("{field} cannot be blank")))
    } else {
        Ok(value)
    }
}

fn validate_path_component<E>(value: &str, field: &str) -> Result<(), E>
where
    E: de::Error,
{
    if value.len() > MAX_PATH_LENGTH {
        return Err(de::Error::custom(format!(
            "{field} exceeds maximum length of {MAX_PATH_LENGTH} characters"
        )));
    }

    if value.contains(['\0', '\r', '\n']) {
        return Err(de::Error::custom(format!(
            "{field} contains invalid control characters"
        )));
    }

    Ok(())
}

pub fn document_path<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    let trimmed = ensure_not_blank::<_, D::Error>(&raw, "document path")?.trim();
    validate_path_component::<D::Error>(trimmed, "document path")?;
    Ok(trimmed.to_string())
}

pub fn content<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    ensure_not_blank::<_, D::Error>(&raw, "content")?;
    Ok(raw)
}

pub fn optional_commit_id<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = Option::<String>::deserialize(deserializer)?;
    match raw.map(|value| value.trim().to_string()) {
        Some(value) if value.is_empty() => Ok(None),
        Some(value) => {
            if !value.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(de::Error::custom("commit id must be hexadecimal"));
            }
            Ok(Some(value))
        }
        None => Ok(None),
    }
}

pub fn search_query<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    let trimmed = ensure_not_blank::<_, D::Error>(&raw, "search query")?.trim();
    if trimmed.len() > MAX_QUERY_LENGTH {
        return Err(de::Error::custom(format!(
            "search query exceeds maximum length of {MAX_QUERY_LENGTH} characters"
        )));
    }
    Ok(trimmed.to_string())
}

pub fn optional_path_prefix<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = Option::<String>::deserialize(deserializer)?;
    match raw.map(|value| value.trim().to_string()) {
        Some(value) if value.is_empty() => Ok(None),
        Some(value) => {
            validate_path_component::<D::Error>(&value, "path prefix")?;
            Ok(Some(value))
        }
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct DocumentInput {
        #[serde(deserialize_with = "document_path")]
        path: String,
        #[serde(deserialize_with = "content")]
        content: String,
        #[serde(default, deserialize_with = "optional_commit_id")]
        commit_id: Option<String>,
    }

    #[test]
    fn trims_document_path() {
        let input: DocumentInput =
            serde_json::from_str(r#"{"path": " src/lib.rs ", "content": "fn main(){}"}"#).unwrap();
        assert_eq!(input.path, "src/lib.rs");
    }

    #[test]
    fn rejects_blank_content() {
        let result: Result<DocumentInput, _> =
            serde_json::from_str(r#"{"path": "src/lib.rs", "content": "    "}"#);
        assert!(result.is_err());
    }

    #[test]
    fn optional_commit_id_filters_empty() {
        let input: DocumentInput =
            serde_json::from_str(r#"{"path": "src/lib.rs", "content": "ok", "commit_id": "   "}"#)
                .unwrap();
        assert!(input.commit_id.is_none());
    }
}
