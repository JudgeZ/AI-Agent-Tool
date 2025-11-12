#![allow(dead_code)]

use std::net::IpAddr;

use uuid::Uuid;

use crate::request_context::{clear_request_context, set_request_context, RequestContext};

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
