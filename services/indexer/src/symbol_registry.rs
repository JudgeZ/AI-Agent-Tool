#![allow(dead_code)]

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::storage::{IndexStorage, StorageError, StoredSymbol};

/// Unique identifier for a symbol based on path, name, and kind
#[derive(Debug, Clone, Hash, Eq, PartialEq, Serialize, Deserialize)]
pub struct SymbolKey {
    pub path: String,
    pub name: String,
    pub kind: SymbolKind,
}

/// Type of symbol in the codebase
#[derive(Debug, Clone, Copy, Hash, Eq, PartialEq, Serialize, Deserialize)]
pub enum SymbolKind {
    Function,
    Class,
    Interface,
    Enum,
    Constant,
    Variable,
    Type,
    Module,
    Method,
    Property,
    Namespace,
    Trait,
    Impl,
    Struct,
}

use std::fmt;
use std::str::FromStr;

impl fmt::Display for SymbolKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            SymbolKind::Function => "function",
            SymbolKind::Class => "class",
            SymbolKind::Interface => "interface",
            SymbolKind::Enum => "enum",
            SymbolKind::Constant => "constant",
            SymbolKind::Variable => "variable",
            SymbolKind::Type => "type",
            SymbolKind::Module => "module",
            SymbolKind::Method => "method",
            SymbolKind::Property => "property",
            SymbolKind::Namespace => "namespace",
            SymbolKind::Trait => "trait",
            SymbolKind::Impl => "impl",
            SymbolKind::Struct => "struct",
        };
        write!(f, "{}", s)
    }
}

impl FromStr for SymbolKind {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "function" => Ok(SymbolKind::Function),
            "class" => Ok(SymbolKind::Class),
            "interface" => Ok(SymbolKind::Interface),
            "enum" => Ok(SymbolKind::Enum),
            "constant" => Ok(SymbolKind::Constant),
            "variable" => Ok(SymbolKind::Variable),
            "type" => Ok(SymbolKind::Type),
            "module" => Ok(SymbolKind::Module),
            "method" => Ok(SymbolKind::Method),
            "property" => Ok(SymbolKind::Property),
            "namespace" => Ok(SymbolKind::Namespace),
            "trait" => Ok(SymbolKind::Trait),
            "impl" => Ok(SymbolKind::Impl),
            "struct" => Ok(SymbolKind::Struct),
            _ => Err(()),
        }
    }
}

/// Symbol data with location and content
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Symbol {
    pub id: Uuid,
    pub key: SymbolKey,
    pub content: String,
    pub location: Range,
    pub doc_comment: Option<String>,
    pub children: Vec<Uuid>,
    pub parent: Option<Uuid>,
    pub commit_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Source location range
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

impl Range {
    pub fn contains(&self, position: Position) -> bool {
        position.line >= self.start.line
            && position.line <= self.end.line
            && (position.line != self.start.line || position.character >= self.start.character)
            && (position.line != self.end.line || position.character <= self.end.character)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Position {
    pub line: usize,
    pub character: usize,
}

/// Registry for managing symbols with stable UUID mappings
pub struct SymbolRegistry {
    /// Path + name + kind -> UUID mapping
    symbol_index: Arc<RwLock<HashMap<SymbolKey, Uuid>>>,
    /// UUID -> current symbol data
    symbols: Arc<RwLock<HashMap<Uuid, Symbol>>>,
    /// Storage backend
    storage: Arc<dyn IndexStorage>,
}

impl SymbolRegistry {
    pub async fn new(storage: Arc<dyn IndexStorage>) -> Result<Self, StorageError> {
        let registry = Self {
            symbol_index: Arc::new(RwLock::new(HashMap::new())),
            symbols: Arc::new(RwLock::new(HashMap::new())),
            storage,
        };

        // Load existing symbols from storage
        registry.load_from_storage().await?;

        Ok(registry)
    }

    /// Load all symbols from storage into the in-memory registry
    async fn load_from_storage(&self) -> Result<(), StorageError> {
        // Query all symbols from storage
        let stored_symbols = self.storage.query_all_symbols().await?;

        let mut index = self.symbol_index.write().await;
        let mut symbols = self.symbols.write().await;

        for stored_symbol in stored_symbols {
            // Parse symbol kind
            let kind = SymbolKind::from_str(&stored_symbol.kind).unwrap_or(SymbolKind::Function);

            let key = SymbolKey {
                path: stored_symbol.path.clone(),
                name: stored_symbol.name.clone(),
                kind,
            };

            // Convert StoredSymbol to Symbol
            let symbol = Symbol {
                id: stored_symbol.id,
                key: key.clone(),
                content: stored_symbol.content,
                location: Range {
                    start: Position {
                        line: stored_symbol.start_line as usize,
                        character: 0, // Not stored, default to 0
                    },
                    end: Position {
                        line: stored_symbol.end_line as usize,
                        character: 0, // Not stored, default to 0
                    },
                },
                doc_comment: None,    // Not stored in current schema
                children: Vec::new(), // Would need separate table for hierarchy
                parent: None,         // Would need separate table for hierarchy
                commit_id: stored_symbol.commit_id,
                created_at: stored_symbol.created_at,
                updated_at: stored_symbol.updated_at,
            };

            // Add to index and symbols map
            index.insert(key, stored_symbol.id);
            symbols.insert(stored_symbol.id, symbol);
        }

        tracing::info!(
            "Loaded {} symbols from storage into registry",
            symbols.len()
        );

        Ok(())
    }

    /// Get or create a symbol with stable UUID
    pub async fn get_or_create_symbol(&self, key: SymbolKey) -> Result<Uuid, StorageError> {
        // Check if symbol already exists
        {
            let index = self.symbol_index.read().await;
            if let Some(id) = index.get(&key) {
                return Ok(*id);
            }
        }

        // Create new symbol if it doesn't exist
        let id = Uuid::new_v4();
        let mut index = self.symbol_index.write().await;
        let mut symbols = self.symbols.write().await;

        // Double-check in case of race condition
        if let Some(existing_id) = index.get(&key) {
            return Ok(*existing_id);
        }

        let symbol = Symbol {
            id,
            key: key.clone(),
            content: String::new(),
            location: Range {
                start: Position {
                    line: 0,
                    character: 0,
                },
                end: Position {
                    line: 0,
                    character: 0,
                },
            },
            doc_comment: None,
            children: Vec::new(),
            parent: None,
            commit_id: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        index.insert(key, id);
        symbols.insert(id, symbol);

        Ok(id)
    }

    /// Update symbol data
    pub async fn update_symbol(
        &self,
        id: Uuid,
        content: String,
        location: Range,
        doc_comment: Option<String>,
        commit_id: Option<String>,
    ) -> Result<(), StorageError> {
        let mut symbols = self.symbols.write().await;

        if let Some(symbol) = symbols.get_mut(&id) {
            symbol.content = content;
            symbol.location = location;
            symbol.doc_comment = doc_comment.clone();
            symbol.commit_id = commit_id;
            symbol.updated_at = Utc::now();

            // Convert to StoredSymbol for persistence
            let stored = StoredSymbol {
                id,
                path: symbol.key.path.clone(),
                name: symbol.key.name.clone(),
                kind: symbol.key.kind.to_string(),
                content: symbol.content.clone(),
                embedding: vec![], // Will be computed later
                commit_id: symbol.commit_id.clone(),
                start_line: symbol.location.start.line as i32,
                end_line: symbol.location.end.line as i32,
                metadata: doc_comment.map(|doc| serde_json::json!({"doc": doc})),
                created_at: symbol.created_at,
                updated_at: symbol.updated_at,
            };

            self.storage.store_symbol(&stored).await?;
        }

        Ok(())
    }

    /// Mark a symbol as deleted in a specific commit
    pub async fn mark_deleted(&self, id: Uuid, commit_id: String) -> Result<(), StorageError> {
        let mut symbols = self.symbols.write().await;

        if let Some(symbol) = symbols.get_mut(&id) {
            symbol.commit_id = Some(commit_id);
            symbol.updated_at = Utc::now();
            // In a real implementation, we might add a "deleted" flag
            // or move to a separate deleted symbols collection
        }

        Ok(())
    }

    /// Find symbols by name
    pub async fn find_by_name(&self, name: &str) -> Vec<Uuid> {
        let symbols = self.symbols.read().await;
        symbols
            .values()
            .filter(|s| s.key.name.contains(name))
            .map(|s| s.id)
            .collect()
    }

    /// Get symbol by ID
    pub async fn get_symbol(&self, id: Uuid) -> Option<Symbol> {
        let symbols = self.symbols.read().await;
        symbols.get(&id).cloned()
    }

    /// Add child relationship
    pub async fn add_child(&self, parent_id: Uuid, child_id: Uuid) -> Result<(), StorageError> {
        let mut symbols = self.symbols.write().await;

        if let Some(parent) = symbols.get_mut(&parent_id) {
            if !parent.children.contains(&child_id) {
                parent.children.push(child_id);
            }
        }

        if let Some(child) = symbols.get_mut(&child_id) {
            child.parent = Some(parent_id);
        }

        Ok(())
    }

    /// Get all symbols in a file
    pub async fn get_symbols_in_file(&self, path: &str) -> Vec<Symbol> {
        let symbols = self.symbols.read().await;
        symbols
            .values()
            .filter(|s| s.key.path == path)
            .cloned()
            .collect()
    }
}
