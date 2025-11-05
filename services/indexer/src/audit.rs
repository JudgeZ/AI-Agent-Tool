use serde::Serialize;
use tracing::info;

#[derive(Serialize)]
struct AuditEvent<'a, D: Serialize> {
    level: &'static str,
    service: &'static str,
    action: &'a str,
    outcome: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    resource: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<D>,
}

pub fn log_audit<D>(action: &str, outcome: &str, resource: Option<&str>, details: Option<D>)
where
    D: Serialize,
{
    let event = AuditEvent {
        level: "audit",
        service: "indexer",
        action,
        outcome,
        resource,
        details,
    };

    match serde_json::to_string(&event) {
        Ok(payload) => info!(target = "audit", "{}", payload),
        Err(error) => {
            info!(target = "audit", action = action, outcome = outcome, error = %error, "audit serialization failed")
        }
    }
}
