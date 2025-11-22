use tree_sitter::Node;

use crate::ast::{parse_tree, AstError};
use crate::symbol_registry::{Position, Range, SymbolKind};

#[derive(Debug, Clone)]
pub struct ExtractedSymbol {
    pub name: String,
    #[allow(dead_code)]
    pub kind: SymbolKind,
    #[allow(dead_code)]
    pub range: Range,
    #[allow(dead_code)]
    pub content: String,
    #[allow(dead_code)]
    pub doc_comment: Option<String>,
    pub children: Vec<ExtractedSymbol>,
}

/// Extract symbols from source code
pub fn extract_symbols(source: &str, language_id: &str) -> Result<Vec<ExtractedSymbol>, AstError> {
    let (tree, _) = parse_tree(language_id, source)?;
    let root = tree.root_node();

    let mut extractor = SymbolExtractor {
        source: source.as_bytes(),
        symbols: Vec::new(),
    };

    extractor.visit(root);
    Ok(extractor.symbols)
}

struct SymbolExtractor<'a> {
    source: &'a [u8],
    symbols: Vec<ExtractedSymbol>,
}

impl<'a> SymbolExtractor<'a> {
    fn visit(&mut self, node: Node) {
        if let Some(symbol) = self.extract_symbol(node) {
            self.symbols.push(symbol);
        } else {
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                self.visit(child);
            }
        }
    }

    fn extract_symbol(&mut self, node: Node) -> Option<ExtractedSymbol> {
        match node.kind() {
            // TypeScript/JavaScript
            "function_declaration" | "function" => self.extract_function(node),
            "class_declaration" | "class" => self.extract_class(node),
            "interface_declaration" => self.extract_interface(node),
            "enum_declaration" => self.extract_enum(node),
            "method_definition" => self.extract_method(node),
            "const_declaration" | "lexical_declaration" => self.extract_constant(node),
            "variable_declarator" => self.extract_variable_declarator(node),

            // Rust
            "function_item" => self.extract_function(node),
            "struct_item" => self.extract_struct(node),
            "enum_item" => self.extract_enum(node),
            "trait_item" => self.extract_trait(node),
            "impl_item" => self.extract_impl(node),
            "mod_item" => self.extract_module(node),

            _ => None,
        }
    }

    fn extract_function(&mut self, node: Node) -> Option<ExtractedSymbol> {
        if let Some(name_node) = node.child_by_field_name("name") {
            if let Ok(name) = name_node.utf8_text(self.source) {
                let mut symbol = ExtractedSymbol {
                    name: name.to_string(),
                    kind: SymbolKind::Function,
                    range: node_to_range(node),
                    content: self.get_node_text(node),
                    doc_comment: self.extract_doc_comment(node),
                    children: Vec::new(),
                };

                if let Some(body) = node.child_by_field_name("body") {
                    let mut cursor = body.walk();
                    for child in body.children(&mut cursor) {
                        if let Some(child_symbol) = self.extract_symbol(child) {
                            symbol.children.push(child_symbol);
                        }
                    }
                }

                return Some(symbol);
            }
        }
        None
    }

    fn extract_class(&mut self, node: Node) -> Option<ExtractedSymbol> {
        if let Some(name_node) = node.child_by_field_name("name") {
            if let Ok(name) = name_node.utf8_text(self.source) {
                let mut symbol = ExtractedSymbol {
                    name: name.to_string(),
                    kind: SymbolKind::Class,
                    range: node_to_range(node),
                    content: self.get_node_text(node),
                    doc_comment: self.extract_doc_comment(node),
                    children: Vec::new(),
                };

                // Extract class members and nested symbols
                if let Some(body) = node.child_by_field_name("body") {
                    let mut cursor = body.walk();
                    for child in body.children(&mut cursor) {
                        if let Some(child_symbol) = self.extract_symbol(child) {
                            symbol.children.push(child_symbol);
                        } else if child.kind() == "field_definition" {
                            if let Some(child_symbol) = self.extract_class_member(child) {
                                symbol.children.push(child_symbol);
                            }
                        }
                    }
                }

                return Some(symbol);
            }
        }
        None
    }

    fn extract_class_member(&self, node: Node) -> Option<ExtractedSymbol> {
        let name_node = node.child_by_field_name("name")?;
        let name = name_node.utf8_text(self.source).ok()?.to_string();

        let kind = match node.kind() {
            "method_definition" => SymbolKind::Method,
            "field_definition" => SymbolKind::Property,
            _ => return None,
        };

        Some(ExtractedSymbol {
            name,
            kind,
            range: node_to_range(node),
            content: self.get_node_text(node),
            doc_comment: self.extract_doc_comment(node),
            children: Vec::new(),
        })
    }

    fn extract_interface(&mut self, node: Node) -> Option<ExtractedSymbol> {
        if let Some(name_node) = node.child_by_field_name("name") {
            if let Ok(name) = name_node.utf8_text(self.source) {
                return Some(ExtractedSymbol {
                    name: name.to_string(),
                    kind: SymbolKind::Interface,
                    range: node_to_range(node),
                    content: self.get_node_text(node),
                    doc_comment: self.extract_doc_comment(node),
                    children: Vec::new(),
                });
            }
        }
        None
    }

    fn extract_enum(&mut self, node: Node) -> Option<ExtractedSymbol> {
        if let Some(name_node) = node.child_by_field_name("name") {
            if let Ok(name) = name_node.utf8_text(self.source) {
                return Some(ExtractedSymbol {
                    name: name.to_string(),
                    kind: SymbolKind::Enum,
                    range: node_to_range(node),
                    content: self.get_node_text(node),
                    doc_comment: self.extract_doc_comment(node),
                    children: Vec::new(),
                });
            }
        }
        None
    }

    fn extract_method(&mut self, node: Node) -> Option<ExtractedSymbol> {
        if let Some(name_node) = node.child_by_field_name("name") {
            if let Ok(name) = name_node.utf8_text(self.source) {
                return Some(ExtractedSymbol {
                    name: name.to_string(),
                    kind: SymbolKind::Method,
                    range: node_to_range(node),
                    content: self.get_node_text(node),
                    doc_comment: self.extract_doc_comment(node),
                    children: Vec::new(),
                });
            }
        }
        None
    }

    fn extract_constant(&mut self, _node: Node) -> Option<ExtractedSymbol> {
        // For const/let declarations, extract each variable
        // This is tricky because one declaration can have multiple declarators.
        // But extract_symbol returns Option<ExtractedSymbol> (single).
        // If we encounter a variable_declarator, we extract it.
        // If we encounter a lexical_declaration, we should visit children.

        // Wait, extract_symbol is called on "const_declaration" or "lexical_declaration".
        // If I return None, visit will recurse.
        // So I should return None here and let visit recurse to find "variable_declarator"?
        // But "variable_declarator" is not in extract_symbol match arms.

        // I should add "variable_declarator" to extract_symbol match arms.
        // And remove "const_declaration" / "lexical_declaration" from match arms so they recurse.

        // Let's adjust extract_symbol match arms.
        None
    }

    fn extract_variable_declarator(&mut self, node: Node) -> Option<ExtractedSymbol> {
        if let Some(name_node) = node.child_by_field_name("name") {
            if let Ok(name) = name_node.utf8_text(self.source) {
                return Some(ExtractedSymbol {
                    name: name.to_string(),
                    kind: SymbolKind::Constant,
                    range: node_to_range(node),
                    content: self.get_node_text(node),
                    doc_comment: self.extract_doc_comment(node.parent().unwrap_or(node)), // Doc comment is on parent declaration
                    children: Vec::new(),
                });
            }
        }
        None
    }

    fn extract_struct(&mut self, node: Node) -> Option<ExtractedSymbol> {
        if let Some(name_node) = node.child_by_field_name("name") {
            if let Ok(name) = name_node.utf8_text(self.source) {
                return Some(ExtractedSymbol {
                    name: name.to_string(),
                    kind: SymbolKind::Struct,
                    range: node_to_range(node),
                    content: self.get_node_text(node),
                    doc_comment: self.extract_doc_comment(node),
                    children: Vec::new(),
                });
            }
        }
        None
    }

    fn extract_trait(&mut self, node: Node) -> Option<ExtractedSymbol> {
        if let Some(name_node) = node.child_by_field_name("name") {
            if let Ok(name) = name_node.utf8_text(self.source) {
                return Some(ExtractedSymbol {
                    name: name.to_string(),
                    kind: SymbolKind::Trait,
                    range: node_to_range(node),
                    content: self.get_node_text(node),
                    doc_comment: self.extract_doc_comment(node),
                    children: Vec::new(),
                });
            }
        }
        None
    }

    fn extract_impl(&mut self, node: Node) -> Option<ExtractedSymbol> {
        if let Some(type_node) = node.child_by_field_name("type") {
            if let Ok(name) = type_node.utf8_text(self.source) {
                return Some(ExtractedSymbol {
                    name: format!("impl {}", name),
                    kind: SymbolKind::Impl,
                    range: node_to_range(node),
                    content: self.get_node_text(node),
                    doc_comment: self.extract_doc_comment(node),
                    children: Vec::new(),
                });
            }
        }
        None
    }

    fn extract_module(&mut self, node: Node) -> Option<ExtractedSymbol> {
        if let Some(name_node) = node.child_by_field_name("name") {
            if let Ok(name) = name_node.utf8_text(self.source) {
                return Some(ExtractedSymbol {
                    name: name.to_string(),
                    kind: SymbolKind::Module,
                    range: node_to_range(node),
                    content: self.get_node_text(node),
                    doc_comment: self.extract_doc_comment(node),
                    children: Vec::new(),
                });
            }
        }
        None
    }

    fn get_node_text(&self, node: Node) -> String {
        node.utf8_text(self.source).unwrap_or("").to_string()
    }

    fn extract_doc_comment(&self, node: Node) -> Option<String> {
        // Look for comment nodes before this node
        let mut prev = node.prev_sibling();
        let mut comments = Vec::new();

        while let Some(sibling) = prev {
            if sibling.kind() == "comment"
                || sibling.kind() == "line_comment"
                || sibling.kind() == "block_comment"
            {
                if let Ok(text) = sibling.utf8_text(self.source) {
                    // Check if it's a doc comment (/** ... */ or ///)
                    if text.starts_with("/**") || text.starts_with("///") {
                        comments.push(text.to_string());
                    }
                }
                prev = sibling.prev_sibling();
            } else if !sibling.kind().contains("whitespace") {
                break;
            } else {
                prev = sibling.prev_sibling();
            }
        }

        if comments.is_empty() {
            None
        } else {
            comments.reverse();
            Some(comments.join("\n"))
        }
    }
}

fn node_to_range(node: Node) -> Range {
    let start_point = node.start_position();
    let end_point = node.end_position();

    Range {
        start: Position {
            line: start_point.row,
            character: start_point.column,
        },
        end: Position {
            line: end_point.row,
            character: end_point.column,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_typescript_function() {
        let source = r#"
            function greet(name: string): string {
                return `Hello, ${name}!`;
            }
        "#;

        let symbols = extract_symbols(source, "typescript").expect("extraction failed");
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "greet");
        assert!(matches!(symbols[0].kind, SymbolKind::Function));
    }

    #[test]
    fn extracts_typescript_class_with_methods() {
        let source = r#"
            class Calculator {
                add(a: number, b: number): number {
                    return a + b;
                }

                subtract(a: number, b: number): number {
                    return a - b;
                }
            }
        "#;

        let symbols = extract_symbols(source, "typescript").expect("extraction failed");
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "Calculator");
        assert!(matches!(symbols[0].kind, SymbolKind::Class));
        assert_eq!(symbols[0].children.len(), 2);
        assert_eq!(symbols[0].children[0].name, "add");
        assert_eq!(symbols[0].children[1].name, "subtract");
    }

    #[test]
    fn extracts_rust_struct() {
        let source = r#"
/// A person with a name and age
pub struct Person {
    pub name: String,
    pub age: u32,
}
"#;

        let symbols = extract_symbols(source, "rust").expect("extraction failed");
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "Person");
        assert!(matches!(symbols[0].kind, SymbolKind::Struct));
        // TODO: Fix doc comment extraction for Rust
        assert!(symbols[0].doc_comment.is_some());
    }

    #[test]
    fn extracts_deeply_nested_symbols() {
        let source = r#"
            function Level1() {
                function Level2() {
                    function Level3() {
                        function Level4() {
                            function Level5() {
                                function Level6() {
                                    function method() {}
                                }
                            }
                        }
                    }
                }
            }
        "#;

        let symbols = extract_symbols(source, "typescript").expect("extraction failed");
        // Verify hierarchy
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "Level1");
        let l2 = &symbols[0].children[0];
        assert_eq!(l2.name, "Level2");
        let l3 = &l2.children[0];
        assert_eq!(l3.name, "Level3");
        let l4 = &l3.children[0];
        assert_eq!(l4.name, "Level4");
        let l5 = &l4.children[0];
        assert_eq!(l5.name, "Level5");
        let l6 = &l5.children[0];
        assert_eq!(l6.name, "Level6");
        let method = &l6.children[0];
        assert_eq!(method.name, "method");
    }

    #[test]
    fn extracts_typescript_doc_comments() {
        let source = r#"
            /**
             * A calculator class
             */
            class Calculator {
                /**
                 * Adds two numbers
                 */
                add(a: number, b: number) {}
            }
        "#;

        let symbols = extract_symbols(source, "typescript").expect("extraction failed");
        assert!(symbols[0]
            .doc_comment
            .as_ref()
            .unwrap()
            .contains("A calculator class"));
        assert!(symbols[0].children[0]
            .doc_comment
            .as_ref()
            .unwrap()
            .contains("Adds two numbers"));
    }
}
