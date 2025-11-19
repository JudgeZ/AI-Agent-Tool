use crate::ast::Position;
use tree_sitter::{Node, Tree};

#[derive(Debug, Clone)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

pub fn node_at_position<'a>(
    tree: &'a Tree,
    position: Position,
) -> Option<Node<'a>> {
    let point = tree_sitter::Point {
        row: position.line as usize,
        column: position.column as usize,
    };
    tree.root_node()
        .descendant_for_point_range(point, point)
}

pub fn identifier_at_position<'a>(
    tree: &'a Tree,
    source: &'a str,
    position: Position,
) -> Option<(String, Node<'a>)> {
    let node = node_at_position(tree, position)?;
    let identifier_node = if is_identifier(&node) {
        node
    } else {
        let mut cursor = node.walk();
        let mut result: Option<Node> = None;
        for child in node.children(&mut cursor) {
            if is_identifier(&child) {
                result = Some(child);
                break;
            }
        }
        result?
    };

    let text = identifier_node
        .utf8_text(source.as_bytes())
        .ok()?
        .trim()
        .to_string();

    if text.is_empty() {
        return None;
    }

    Some((text, identifier_node))
}

pub fn is_identifier(node: &Node) -> bool {
    matches!(
        node.kind(),
        "identifier"
            | "property_identifier"
            | "shorthand_property_identifier"
            | "type_identifier"
            | "predefined_type"
    )
}

pub fn find_declaration(tree: &Tree, source: &str, name: &str) -> Option<Range> {
    let mut stack = vec![tree.root_node()];

    while let Some(node) = stack.pop() {
        if looks_like_declaration(&node, source.as_bytes(), name) {
            return Some(to_range(node.range()));
        }
        let mut child_cursor = node.walk();
        for child in node.children(&mut child_cursor) {
            if child.is_named() {
                stack.push(child);
            }
        }
    }

    None
}

fn looks_like_declaration(node: &Node, source: &[u8], name: &str) -> bool {
    const DECL_KINDS: &[&str] = &[
        "function_declaration",
        "method_definition",
        "lexical_declaration",
        "variable_declaration",
        "variable_declarator",
        "class_declaration",
        "interface_declaration",
        "type_alias_declaration",
        "enum_declaration",
    ];

    if !DECL_KINDS.contains(&node.kind()) {
        return false;
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if !child.is_named() {
            continue;
        }
        if is_identifier(&child) {
            if let Ok(text) = child.utf8_text(source) {
                if text.trim() == name {
                    return true;
                }
            }
        }
    }

    false
}

pub fn find_references(tree: &Tree, source: &str, name: &str) -> Vec<Range> {
    let mut stack = vec![tree.root_node()];
    let mut ranges = Vec::new();

    while let Some(node) = stack.pop() {
        if is_identifier(&node) {
            if let Ok(text) = node.utf8_text(source.as_bytes()) {
                if text.trim() == name {
                    ranges.push(to_range(node.range()));
                }
            }
        }

        let mut child_cursor = node.walk();
        for child in node.children(&mut child_cursor) {
            if child.is_named() {
                stack.push(child);
            }
        }
    }

    ranges
}

fn to_range(range: tree_sitter::Range) -> Range {
    Range {
        start: Position {
            line: range.start_point.row as u32,
            column: range.start_point.column as u32,
        },
        end: Position {
            line: range.end_point.row as u32,
            column: range.end_point.column as u32,
        },
    }
}

// Basic graph analysis
#[derive(Debug, Clone)]
pub struct GraphNode {
    pub id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone)]
pub struct GraphEdge {
    pub from_id: String,
    pub to_id: String,
    pub relation: String,
}

pub fn analyze_graph(tree: &Tree, source: &str, path: &str) -> (Vec<GraphNode>, Vec<GraphEdge>) {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut stack = vec![tree.root_node()];

    // Simple heuristic: 
    // 1. Find declarations -> Nodes
    // 2. Find calls/usages inside declarations -> Edges

    // We need to track the current scope (parent declaration)
    // This is a simplified traversal.
    
    // First pass: collect all declarations
    let mut declarations = Vec::new();
    
    while let Some(node) = stack.pop() {
        if is_declaration(&node) {
            if let Some(name) = get_name(&node, source) {
                let id = format!("{}::{}", path, name);
                nodes.push(GraphNode {
                    id: id.clone(),
                    name: name.clone(),
                    kind: node.kind().to_string(),
                });
                declarations.push((id, node));
            }
        }
        
        let mut child_cursor = node.walk();
        for child in node.children(&mut child_cursor) {
            if child.is_named() {
                stack.push(child);
            }
        }
    }

    // Second pass: find usages within declarations
    for (parent_id, parent_node) in declarations {
        let mut stack = vec![parent_node];
        while let Some(node) = stack.pop() {
            // Don't recurse into nested declarations for this scope (simplified)
            if is_declaration(&node) && node.id() != parent_node.id() {
                continue;
            }

            if is_call_expression(&node) {
                if let Some(callee_name) = get_callee_name(&node, source) {
                    // Create an edge to a potential node
                    // In a real system, we would resolve this name to a specific ID
                    // For now, we just assume it might be in the same file or external
                    let to_id = format!("{}::{}", path, callee_name); // Naive resolution
                    edges.push(GraphEdge {
                        from_id: parent_id.clone(),
                        to_id,
                        relation: "calls".to_string(),
                    });
                }
            }

            let mut child_cursor = node.walk();
            for child in node.children(&mut child_cursor) {
                if child.is_named() {
                    stack.push(child);
                }
            }
        }
    }

    (nodes, edges)
}

fn is_declaration(node: &Node) -> bool {
    matches!(
        node.kind(),
        "function_declaration"
            | "method_definition"
            | "class_declaration"
            | "interface_declaration"
    )
}

fn is_call_expression(node: &Node) -> bool {
    matches!(
        node.kind(),
        "call_expression" | "new_expression"
    )
}

fn get_name(node: &Node, source: &str) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if is_identifier(&child) {
            return child.utf8_text(source.as_bytes()).ok().map(|s| s.to_string());
        }
    }
    None
}

fn get_callee_name(node: &Node, source: &str) -> Option<String> {
    // For call_expression, the first child is usually the function being called
    let child = node.child(0)?;
    if is_identifier(&child) {
        return child.utf8_text(source.as_bytes()).ok().map(|s| s.to_string());
    }
    // Handle member expression (obj.method())
    if child.kind() == "member_expression" {
        let property = child.child_by_field_name("property")?;
        return property.utf8_text(source.as_bytes()).ok().map(|s| s.to_string());
    }
    None
}

