use serde::Serialize;
use thiserror::Error;
use tree_sitter::{Language, Node, Parser, Tree};

const DEFAULT_MAX_DEPTH: usize = 5;
const DEFAULT_MAX_NODES: usize = 2048;

#[derive(Debug, Error)]
pub enum AstError {
    #[error("unsupported language: {0}")]
    UnsupportedLanguage(String),
    #[error("failed to configure parser for language: {0}")]
    LanguageUnavailable(String),
    #[error("failed to parse source")]
    Parse,
    #[error("tree serialization limit exceeded")]
    LimitExceeded,
}

#[derive(Debug, Clone, Serialize)]
pub struct AstNode {
    pub kind: String,
    pub start: Position,
    pub end: Position,
    pub start_byte: usize,
    pub end_byte: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<AstNode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Position {
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct AstResponse {
    pub language: String,
    pub root: AstNode,
    pub statistics: AstStatistics,
}

#[derive(Debug, Clone, Serialize)]
pub struct AstStatistics {
    pub total_nodes: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone)]
pub struct AstOptions {
    pub max_depth: usize,
    pub max_nodes: usize,
    pub include_snippet: bool,
}

impl Default for AstOptions {
    fn default() -> Self {
        Self {
            max_depth: DEFAULT_MAX_DEPTH,
            max_nodes: DEFAULT_MAX_NODES,
            include_snippet: true,
        }
    }
}

pub fn parse_tree(language_id: &str, source: &str) -> Result<(Tree, Language), AstError> {
    let mut parser = Parser::new();
    let language = language_for_id(language_id)
        .ok_or_else(|| AstError::UnsupportedLanguage(language_id.to_string()))?;
    parser
        .set_language(&language)
        .map_err(|_| AstError::LanguageUnavailable(language_id.to_string()))?;
    parser
        .parse(source, None)
        .map(|tree| (tree, language))
        .ok_or(AstError::Parse)
}

pub fn build_ast(
    language_id: &str,
    source: &str,
    options: AstOptions,
) -> Result<AstResponse, AstError> {
    let (tree, _) = parse_tree(language_id, source)?;
    let root = tree.root_node();
    let mut stats = AstStatistics {
        total_nodes: 0,
        truncated: false,
    };
    let mut remaining = options.max_nodes;
    let root_node = serialize_node(
        root,
        source.as_bytes(),
        0,
        &options,
        &mut remaining,
        &mut stats,
    )
    .ok_or(AstError::LimitExceeded)?;

    stats.truncated = remaining == 0;

    Ok(AstResponse {
        language: language_id.to_string(),
        root: root_node,
        statistics: stats,
    })
}

fn serialize_node(
    node: Node,
    source: &[u8],
    depth: usize,
    options: &AstOptions,
    remaining: &mut usize,
    stats: &mut AstStatistics,
) -> Option<AstNode> {
    if *remaining == 0 {
        return None;
    }
    *remaining -= 1;
    stats.total_nodes += 1;

    let range = node.range();
    let mut ast_node = AstNode {
        kind: node.kind().to_string(),
        start: to_position(range.start_point),
        end: to_position(range.end_point),
        start_byte: range.start_byte,
        end_byte: range.end_byte,
        children: Vec::new(),
        snippet: None,
    };

    if options.include_snippet {
        if let Ok(text) = node.utf8_text(source) {
            let snippet = text.trim();
            if !snippet.is_empty() {
                let truncated = if snippet.len() > 120 {
                    format!("{}…", snippet.chars().take(120).collect::<String>())
                } else {
                    snippet.to_string()
                };
                ast_node.snippet = Some(truncated);
            }
        }
    }

    if depth < options.max_depth {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if !child.is_named() {
                continue;
            }
            if *remaining == 0 {
                break;
            }
            if let Some(serialized) =
                serialize_node(child, source, depth + 1, options, remaining, stats)
            {
                ast_node.children.push(serialized);
            }
        }
    }

    Some(ast_node)
}

fn language_for_id(id: &str) -> Option<Language> {
    match id {
        "typescript" | "ts" => Some(tree_sitter_typescript::language_typescript()),
        "tsx" => Some(tree_sitter_typescript::language_tsx()),
        "javascript" | "js" => Some(tree_sitter_javascript::language()),
        "json" => Some(tree_sitter_json::language()),
        "rust" | "rs" => Some(tree_sitter_rust::language()),
        _ => None,
    }
}

fn to_position(point: tree_sitter::Point) -> Position {
    Position {
        line: point.row as u32,
        column: point.column as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_typescript_ast() {
        let source = "const answer = 42;";
        let response = build_ast(
            "typescript",
            source,
            AstOptions {
                max_depth: 3,
                max_nodes: 32,
                include_snippet: true,
            },
        )
        .expect("ast generation");

        assert_eq!(response.language, "typescript");
        assert_eq!(response.root.kind, "program");
        assert!(response.statistics.total_nodes > 0);
    }

    #[test]
    fn rejects_unknown_language() {
        let err = build_ast("unknown", "", AstOptions::default()).unwrap_err();
        assert!(matches!(err, AstError::UnsupportedLanguage(_)));
    }
}
