use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::RwLock;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tower_lsp::jsonrpc::Result as LspResult;
use tower_lsp::lsp_types::{
    InitializeParams, InitializeResult, InitializedParams, Location, MessageType, Position, Range,
    ServerCapabilities, TextDocumentContentChangeEvent, TextDocumentItem,
    TextDocumentSyncCapability, TextDocumentSyncKind, TextDocumentSyncOptions, Url,
};
use tower_lsp::{lsp_types, Client, LanguageServer, LspService, Server};

use tracing::{error, info, warn};

use crate::ast;

const LSP_DEFAULT_ADDR: &str = "127.0.0.1:9257";
const LSP_ACCEPT_TIMEOUT_MS: u64 = 1000;

#[derive(Debug, Clone)]
struct Document {
    language_id: String,
    text: String,
    tree: tree_sitter::Tree,
}

#[derive(Clone)]
pub struct Backend {
    client: Client,
    documents: Arc<RwLock<HashMap<Url, Document>>>,
}

impl Backend {
    pub fn new(client: Client) -> Self {
        Self {
            client,
            documents: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    async fn upsert_document(&self, text_document: TextDocumentItem) {
        match parse_document(&text_document.language_id, &text_document.text) {
            Ok(tree) => {
                let document = Document {
                    language_id: text_document.language_id,
                    text: text_document.text,
                    tree,
                };
                self.documents
                    .write()
                    .await
                    .insert(text_document.uri, document);
            }
            Err(err) => {
                warn!("failed to parse document: {err}");
                self.client
                    .log_message(
                        MessageType::WARNING,
                        format!("Failed to parse document: {err}"),
                    )
                    .await;
            }
        }
    }

    async fn update_document(
        &self,
        uri: &Url,
        changes: &[TextDocumentContentChangeEvent],
    ) -> Option<Document> {
        let change = changes.last()?;
        let new_text = match (change.range.as_ref(), change.range_length) {
            (None, None) => change.text.clone(),
            _ => {
                warn!("partial text updates are not supported; falling back to full document replacement");
                change.text.clone()
            }
        };

        let language_id = {
            let docs = self.documents.read().await;
            docs.get(uri)?.language_id.clone()
        };

        match parse_document(&language_id, &new_text) {
            Ok(tree) => {
                let document = Document {
                    language_id,
                    text: new_text,
                    tree,
                };
                self.documents
                    .write()
                    .await
                    .insert(uri.clone(), document.clone());
                Some(document)
            }
            Err(err) => {
                self.client
                    .log_message(
                        MessageType::WARNING,
                        format!("Failed to update document: {err}"),
                    )
                    .await;
                None
            }
        }
    }

    async fn remove_document(&self, uri: &Url) {
        self.documents.write().await.remove(uri);
    }

    async fn document(&self, uri: &Url) -> Option<Document> {
        self.documents.read().await.get(uri).cloned()
    }
}

#[tower_lsp::async_trait]
impl LanguageServer for Backend {
    async fn initialize(&self, _params: InitializeParams) -> LspResult<InitializeResult> {
        let capabilities = ServerCapabilities {
            text_document_sync: Some(TextDocumentSyncCapability::Options(
                TextDocumentSyncOptions {
                    open_close: Some(true),
                    change: Some(TextDocumentSyncKind::FULL),
                    will_save: None,
                    will_save_wait_until: None,
                    save: None,
                },
            )),
            hover_provider: Some(lsp_types::HoverProviderCapability::Simple(true)),
            definition_provider: Some(lsp_types::OneOf::Left(true)),
            references_provider: Some(lsp_types::OneOf::Left(true)),
            ..Default::default()
        };

        Ok(InitializeResult {
            capabilities,
            server_info: Some(lsp_types::ServerInfo {
                name: "oss-indexer".into(),
                version: Some(env!("CARGO_PKG_VERSION").into()),
            }),
        })
    }

    async fn initialized(&self, _params: InitializedParams) {
        self.client
            .log_message(MessageType::INFO, "Indexer LSP ready")
            .await;
    }

    async fn shutdown(&self) -> LspResult<()> {
        Ok(())
    }

    async fn did_open(&self, params: lsp_types::DidOpenTextDocumentParams) {
        self.upsert_document(params.text_document).await;
    }

    async fn did_change(&self, params: lsp_types::DidChangeTextDocumentParams) {
        self.update_document(&params.text_document.uri, &params.content_changes)
            .await;
    }

    async fn did_close(&self, params: lsp_types::DidCloseTextDocumentParams) {
        self.remove_document(&params.text_document.uri).await;
    }

    async fn hover(&self, params: lsp_types::HoverParams) -> LspResult<Option<lsp_types::Hover>> {
        let uri = params.text_document_position_params.text_document.uri;
        let position = params.text_document_position_params.position;
        let document = match self.document(&uri).await {
            Some(doc) => doc,
            None => return Ok(None),
        };

        if let Some(node) = node_at_position(&document, position) {
            let range = to_lsp_range(node.range());
            let snippet = node
                .utf8_text(document.text.as_bytes())
                .unwrap_or_default()
                .trim()
                .to_string();
            let contents = if snippet.is_empty() {
                format!("Node kind: {}", node.kind())
            } else {
                format!("{}\n```\n{}\n```", node.kind(), snippet)
            };
            return Ok(Some(lsp_types::Hover {
                contents: lsp_types::HoverContents::Scalar(lsp_types::MarkedString::String(
                    contents,
                )),
                range: Some(range),
            }));
        }

        Ok(None)
    }

    async fn goto_definition(
        &self,
        params: lsp_types::GotoDefinitionParams,
    ) -> LspResult<Option<lsp_types::GotoDefinitionResponse>> {
        let uri = params.text_document_position_params.text_document.uri;
        let position = params.text_document_position_params.position;
        let document = match self.document(&uri).await {
            Some(doc) => doc,
            None => return Ok(None),
        };

        if let Some((name, _node)) = identifier_at_position(&document, position) {
            if let Some(range) = find_declaration(&document, &name) {
                let location = Location { uri, range };
                return Ok(Some(lsp_types::GotoDefinitionResponse::Scalar(location)));
            }
        }

        Ok(None)
    }

    async fn references(
        &self,
        params: lsp_types::ReferenceParams,
    ) -> LspResult<Option<Vec<Location>>> {
        let uri = params.text_document_position.text_document.uri;
        let position = params.text_document_position.position;
        let document = match self.document(&uri).await {
            Some(doc) => doc,
            None => return Ok(None),
        };

        let (name, node) = match identifier_at_position(&document, position) {
            Some(value) => value,
            None => return Ok(None),
        };

        let include_decl = params.context.include_declaration;
        let mut locations = Vec::new();

        if include_decl {
            if let Some(range) = find_declaration(&document, &name) {
                locations.push(Location {
                    uri: uri.clone(),
                    range,
                });
            }
        }

        for range in find_references(&document, &name) {
            if range == to_lsp_range(node.range()) {
                continue;
            }
            locations.push(Location {
                uri: uri.clone(),
                range,
            });
        }

        Ok(Some(locations))
    }
}

fn parse_document(language_id: &str, text: &str) -> Result<tree_sitter::Tree, ast::AstError> {
    ast::parse_tree(language_id, text).map(|(tree, _)| tree)
}

fn node_at_position(document: &Document, position: Position) -> Option<tree_sitter::Node<'_>> {
    let point = tree_sitter::Point {
        row: position.line as usize,
        column: position.character as usize,
    };
    document
        .tree
        .root_node()
        .descendant_for_point_range(point, point)
}

fn identifier_at_position(
    document: &Document,
    position: Position,
) -> Option<(String, tree_sitter::Node<'_>)> {
    let node = node_at_position(document, position)?;
    let identifier_node = if is_identifier(&node) {
        node
    } else {
        let mut cursor = node.walk();
        let mut result: Option<tree_sitter::Node> = None;
        for child in node.children(&mut cursor) {
            if is_identifier(&child) {
                result = Some(child);
                break;
            }
        }
        result?
    };

    let text = identifier_node
        .utf8_text(document.text.as_bytes())
        .ok()?
        .trim()
        .to_string();

    if text.is_empty() {
        return None;
    }

    Some((text, identifier_node))
}

fn is_identifier(node: &tree_sitter::Node) -> bool {
    matches!(
        node.kind(),
        "identifier"
            | "property_identifier"
            | "shorthand_property_identifier"
            | "type_identifier"
            | "predefined_type"
    )
}

fn find_declaration(document: &Document, name: &str) -> Option<Range> {
    let mut stack = vec![document.tree.root_node()];

    while let Some(node) = stack.pop() {
        if looks_like_declaration(&node, document.text.as_bytes(), name) {
            return Some(to_lsp_range(node.range()));
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

fn looks_like_declaration(node: &tree_sitter::Node, source: &[u8], name: &str) -> bool {
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

fn find_references(document: &Document, name: &str) -> Vec<Range> {
    let mut stack = vec![document.tree.root_node()];
    let mut ranges = Vec::new();

    while let Some(node) = stack.pop() {
        if is_identifier(&node) {
            if let Ok(text) = node.utf8_text(document.text.as_bytes()) {
                if text.trim() == name {
                    ranges.push(to_lsp_range(node.range()));
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

fn to_lsp_range(range: tree_sitter::Range) -> Range {
    Range {
        start: Position {
            line: range.start_point.row as u32,
            character: range.start_point.column as u32,
        },
        end: Position {
            line: range.end_point.row as u32,
            character: range.end_point.column as u32,
        },
    }
}

pub fn spawn_lsp_listener(addr: Option<String>) -> JoinHandle<()> {
    let address = addr.unwrap_or_else(|| LSP_DEFAULT_ADDR.to_string());
    tokio::spawn(async move {
        if let Err(err) = run_lsp_server(address).await {
            error!("lsp server failed: {err}");
        }
    })
}

async fn run_lsp_server(addr: String) -> std::io::Result<()> {
    let listener = TcpListener::bind(&addr).await?;
    info!(%addr, "lsp server listening");

    loop {
        match timeout(
            Duration::from_millis(LSP_ACCEPT_TIMEOUT_MS),
            listener.accept(),
        )
        .await
        {
            Ok(Ok((stream, peer))) => {
                info!(%peer, "lsp client connected");
                tokio::spawn(handle_client(stream));
            }
            Ok(Err(err)) => {
                error!("failed to accept lsp client: {err}");
            }
            Err(_) => {
                // accept timeout; continue loop allowing graceful shutdown via task abort
                continue;
            }
        }
    }
}

async fn handle_client(stream: TcpStream) {
    let (read, write) = stream.into_split();
    let (service, socket) = LspService::new(|client| Backend::new(client));
    let server = Server::new(read, write, socket);
    server.serve(service).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifier_detection() {
        let code = "const answer = 42;";
        let tree = parse_document("typescript", code).expect("tree");
        let document = Document {
            language_id: "typescript".into(),
            text: code.into(),
            tree,
        };
        let node = node_at_position(
            &document,
            Position {
                line: 0,
                character: 6,
            },
        )
        .expect("node at position");

        assert_eq!(node.kind(), "identifier");
    }
}
