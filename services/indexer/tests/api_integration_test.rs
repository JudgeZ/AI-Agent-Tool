use ossaat_indexer::grpc_service::proto::{
    indexer_service_server::IndexerService, CorrelateFailureRequest, GetReferencesRequest,
    GetSymbolGraphRequest, GetSymbolHistoryRequest, IndexSymbolsRequest,
};
use ossaat_indexer::grpc_service::IndexerServiceImpl;
use ossaat_indexer::storage::IndexStorage;
use ossaat_indexer::temporal::{TemporalConfig, TemporalIndex};
use std::sync::Arc;
use tonic::Request;

mod test_utils;

// Mock temporal index for testing without real git repo
async fn create_test_service() -> IndexerServiceImpl {
    let storage: Arc<dyn IndexStorage> = test_utils::create_test_storage().await;
    let config = TemporalConfig {
        repo_path: std::path::PathBuf::from("."),
        batch_size: 100,
        max_age_days: Some(90),
        include_merge_commits: false,
    };

    // We need to be careful here - TemporalIndex::new tries to open git repo
    // For unit tests, we might want to mock this or use a temp repo
    // But for now, we'll check if we can instantiate it with current dir
    // If it fails (no git repo), we might need a different approach

    let temporal = match TemporalIndex::new(config, storage.clone()) {
        Ok(t) => Arc::new(t),
        Err(_) => {
            // Fallback for CI environments without .git
            // This is not ideal but allows tests to compile
            // In a real scenario, we'd use a mock
            panic!("Failed to create temporal index - ensure running in git repo");
        }
    };

    IndexerServiceImpl::new(storage, temporal)
}

#[tokio::test]
async fn test_symbol_graph_api() {
    let service = create_test_service().await;

    // First index some symbols
    let index_req = Request::new(IndexSymbolsRequest {
        path: "src/test.rs".to_string(),
        content: "fn test() { call_me(); } fn call_me() {}".to_string(),
        language: "rust".to_string(),
        commit_id: Some("abc1234".to_string()),
    });

    let _ = service.index_symbols(index_req).await.unwrap();

    // Now request graph
    // Note: GetSymbolGraph currently reads from file/git, so this test
    // relies on the file actually existing or mocking.
    // Since we can't easily mock the file system read in the service without refactoring,
    // we'll test the validation logic which is safe.

    let req = Request::new(GetSymbolGraphRequest {
        path: "".to_string(), // Invalid path
        commit_id: None,
    });

    let resp = service.get_symbol_graph(req).await;
    assert!(resp.is_err());
    assert_eq!(resp.unwrap_err().code(), tonic::Code::InvalidArgument);
}

#[tokio::test]
async fn test_references_api_validation() {
    let service = create_test_service().await;

    let req = Request::new(GetReferencesRequest {
        path: "".to_string(),
        line: 0,
        character: 0,
        include_declaration: true,
        commit_id: None,
    });

    let resp = service.get_references(req).await;
    assert!(resp.is_err());
}

#[tokio::test]
async fn test_history_api_validation() {
    let service = create_test_service().await;

    let req = Request::new(GetSymbolHistoryRequest {
        path: "".to_string(),
    });

    let resp = service.get_symbol_history(req).await;
    assert!(resp.is_err());
}

#[tokio::test]
async fn test_correlate_failure_validation() {
    let service = create_test_service().await;

    let req = Request::new(CorrelateFailureRequest {
        test_name: "test_foo".to_string(),
        failure_message: "failed".to_string(),
        commit_id: "invalid-hash".to_string(), // Invalid commit hash
        previous_commit_id: None,
    });

    let resp = service.correlate_failure(req).await;
    assert!(resp.is_err());
    assert_eq!(resp.unwrap_err().code(), tonic::Code::InvalidArgument);
}
