mod ast;
mod audit;
mod lsp;
mod request_context;
mod security;
mod semantic;
mod server;
mod telemetry;
mod validation;

#[cfg(test)]
pub mod test_support;

#[tokio::main]
async fn main() -> Result<(), server::IndexerError> {
    server::run().await
}
