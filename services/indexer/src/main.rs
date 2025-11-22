mod analysis;
mod ast;
mod audit;
mod embeddings;
mod grpc_service;
mod lsp;
mod request_context;
mod security;
// mod semantic;
mod server;
mod storage;
mod symbol_extractor;
mod symbol_registry;
mod telemetry;
mod temporal;
mod validation;

#[tokio::main]
async fn main() -> Result<(), server::IndexerError> {
    server::run().await
}
