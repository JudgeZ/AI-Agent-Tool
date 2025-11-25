use opentelemetry::KeyValue;
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::trace::Tracer;
use opentelemetry_sdk::Resource;
use std::env;
use std::sync::atomic::{AtomicBool, Ordering};
use thiserror::Error;
use tracing_opentelemetry::OpenTelemetryLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

const SERVICE_NAME: &str = "ossaat-indexer";
const SERVICE_VERSION: &str = env!("CARGO_PKG_VERSION");

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

    match otlp_endpoint {
        Some(endpoint) => {
            let tracer = init_otlp_tracer(&endpoint)?;
            let otel_layer = OpenTelemetryLayer::new(tracer);

            OTLP_INITIALIZED.store(true, Ordering::SeqCst);

            tracing_subscriber::registry()
                .with(env_filter)
                .with(fmt_layer)
                .with(otel_layer)
                .try_init()
                .map_err(TelemetryError::from)
        }
        None => tracing_subscriber::registry()
            .with(env_filter)
            .with(fmt_layer)
            .try_init()
            .map_err(TelemetryError::from),
    }
}

fn init_otlp_tracer(endpoint: &str) -> Result<Tracer, TelemetryError> {
    let exporter = opentelemetry_otlp::new_exporter()
        .tonic()
        .with_endpoint(endpoint);

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

    #[test]
    fn init_tracing_is_idempotent() {
        assert!(init_tracing().is_ok(), "first init should succeed");
        assert!(init_tracing().is_ok(), "second init should be a no-op");
    }

    #[test]
    fn shutdown_tracing_is_safe_when_not_initialized() {
        // Shutdown should be a no-op when OTLP was never initialized.
        // This test verifies no panic occurs.
        shutdown_tracing();
    }
}
