#![allow(dead_code)]

use std::net::IpAddr;
use std::sync::Arc;

use uuid::Uuid;

use ossaat_indexer::request_context::{clear_request_context, set_request_context, RequestContext};
use ossaat_indexer::storage::{IndexStorage, StorageError, StoredDocument, StoredSymbol};

pub fn install_test_context(request_id: Uuid, trace_id: Option<&str>, client_ip: Option<IpAddr>) {
    clear_request_context();
    let mut context = RequestContext::new(request_id);
    if let Some(trace) = trace_id {
        context = context.with_trace_id(trace);
    }
    if let Some(ip) = client_ip {
        context = context.with_client_ip(ip);
    }
    set_request_context(context);
}

pub fn reset_context() {
    clear_request_context();
}

pub struct MockStorage;

#[async_trait::async_trait]
impl IndexStorage for MockStorage {
    async fn index_document(
        &self,
        _path: String,
        _content: String,
        _commit_id: Option<String>,
    ) -> Result<Uuid, StorageError> {
        Ok(Uuid::new_v4())
    }

    async fn index_symbols(
        &self,
        _path: String,
        _content: String,
        _language: String,
        _commit_id: Option<String>,
    ) -> Result<usize, StorageError> {
        Ok(0)
    }

    async fn search_documents(
        &self,
        _query: String,
        _top_k: usize,
        _path_prefix: Option<String>,
        _commit_id: Option<String>,
    ) -> Result<Vec<(StoredDocument, f32)>, StorageError> {
        Ok(vec![])
    }

    async fn search_symbols(
        &self,
        _query: String,
        _top_k: usize,
        _path_prefix: Option<String>,
        _commit_id: Option<String>,
    ) -> Result<Vec<(StoredSymbol, f32)>, StorageError> {
        Ok(vec![])
    }

    async fn query_all_symbols(&self) -> Result<Vec<StoredSymbol>, StorageError> {
        Ok(vec![])
    }

    async fn store_symbol(&self, _symbol: &StoredSymbol) -> Result<(), StorageError> {
        Ok(())
    }
}

pub async fn create_test_storage() -> Arc<dyn IndexStorage> {
    Arc::new(MockStorage)
}
