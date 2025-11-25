use opentelemetry::KeyValue;
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::trace::Tracer;
use opentelemetry_sdk::Resource;
use std::env;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use thiserror::Error;
use tracing_opentelemetry::OpenTelemetryLayer;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

const SERVICE_NAME: &str = "ossaat-indexer";
const SERVICE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Timeout for OTLP exporter operations to prevent indefinite blocking.
const OTLP_EXPORT_TIMEOUT: Duration = Duration::from_secs(10);

/// Tracks whether OTLP tracing was successfully initialized.
///
/// This global flag is necessary because `tracing::dispatcher::has_been_set()` only
/// tells us if *any* subscriber was installed, not whether OTLP specifically was
/// configured. We need this to know whether `shutdown_tracing()` should call
/// `shutdown_tracer_provider()`.
///
/// Note: This global state means tests touching tracing must be serialized.
/// Use `#[serial]` from `serial_test` crate for tests that call `init_tracing()`.
static OTLP_INITIALIZED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Error)]
pub enum TelemetryError {
    #[error("failed to initialize tracing subscriber: {0}")]
    Subscriber(#[from] tracing_subscriber::util::TryInitError),
    #[error("failed to initialize OpenTelemetry tracer: {0}")]
    Tracer(#[from] opentelemetry::trace::TraceError),
}

/// Initializes tracing with console output and optional OTLP export.
///
/// When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, traces are exported to the
/// configured endpoint (typically Jaeger). If the variable is unset or empty,
/// only console logging is enabled.
///
/// This function is idempotent; subsequent calls are no-ops.
pub fn init_tracing() -> Result<(), TelemetryError> {
    if tracing::dispatcher::has_been_set() {
        return Ok(());
    }

    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let fmt_layer = tracing_subscriber::fmt::layer();

    let otlp_endpoint = env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
        .ok()
        .filter(|s| !s.trim().is_empty());

    let has_otlp = otlp_endpoint.is_some();

    // Build optional OTLP layer if endpoint is configured
    let otel_layer = otlp_endpoint
        .map(|endpoint| init_otlp_tracer(&endpoint))
        .transpose()?
        .map(OpenTelemetryLayer::new);

    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt_layer)
        .with(otel_layer)
        .try_init()?;

    // Only set the flag after successful initialization to avoid race condition
    // where shutdown_tracing() might be called on a failed/partial init
    if has_otlp {
        OTLP_INITIALIZED.store(true, Ordering::SeqCst);
    }

    Ok(())
}

/// Creates an OTLP tracer configured for the given endpoint.
///
/// The tracer is configured with:
/// - Service name and version as resource attributes for trace identification
/// - Export timeout to prevent indefinite blocking on unresponsive endpoints
/// - Batch processing using the Tokio runtime
///
/// # Arguments
///
/// * `endpoint` - The OTLP collector endpoint URL (e.g., `http://jaeger:4317`)
///
/// # Errors
///
/// Returns `TelemetryError::Tracer` if the tracer pipeline fails to initialize.
fn init_otlp_tracer(endpoint: &str) -> Result<Tracer, TelemetryError> {
    let exporter = opentelemetry_otlp::new_exporter()
        .tonic()
        .with_endpoint(endpoint)
        .with_timeout(OTLP_EXPORT_TIMEOUT);

    let resource = Resource::new(vec![
        KeyValue::new(
            opentelemetry_semantic_conventions::resource::SERVICE_NAME,
            SERVICE_NAME,
        ),
        KeyValue::new(
            opentelemetry_semantic_conventions::resource::SERVICE_VERSION,
            SERVICE_VERSION,
        ),
    ]);

    let tracer = opentelemetry_otlp::new_pipeline()
        .tracing()
        .with_exporter(exporter)
        .with_trace_config(opentelemetry_sdk::trace::Config::default().with_resource(resource))
        .install_batch(opentelemetry_sdk::runtime::Tokio)?;

    Ok(tracer)
}

/// Shuts down the OpenTelemetry tracer provider, flushing any pending spans.
///
/// This should be called during graceful shutdown to ensure all traces are
/// exported before the process exits.
pub fn shutdown_tracing() {
    if OTLP_INITIALIZED.load(Ordering::SeqCst) {
        opentelemetry::global::shutdown_tracer_provider();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    // Tests are serialized because:
    // 1. `tracing::dispatcher` is a global singleton - once set, it persists
    // 2. `OTLP_INITIALIZED` is a global flag that tracks OTLP state
    // Running tests in parallel could cause state leakage and flaky failures.

    #[test]
    #[serial]
    fn init_tracing_is_idempotent() {
        assert!(init_tracing().is_ok(), "first init should succeed");
        assert!(init_tracing().is_ok(), "second init should be a no-op");
    }

    #[test]
    #[serial]
    fn shutdown_tracing_is_safe_when_not_initialized() {
        // Shutdown should be a no-op when OTLP was never initialized.
        // This test verifies no panic occurs.
        shutdown_tracing();
    }
}
