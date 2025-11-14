#![allow(dead_code)]

use std::cell::RefCell;
use std::net::IpAddr;

use uuid::Uuid;

std::thread_local! {
    #[allow(clippy::missing_const_for_thread_local)]
    static CONTEXT: RefCell<Option<RequestContext>> = RefCell::new(None);
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestContext {
    request_id: Uuid,
    trace_id: Option<String>,
    client_ip: Option<IpAddr>,
}

impl RequestContext {
    pub fn new(request_id: Uuid) -> Self {
        Self {
            request_id,
            trace_id: None,
            client_ip: None,
        }
    }

    pub fn with_trace_id<T: Into<String>>(mut self, trace_id: T) -> Self {
        self.trace_id = Some(trace_id.into());
        self
    }

    pub fn with_client_ip(mut self, client_ip: IpAddr) -> Self {
        self.client_ip = Some(client_ip);
        self
    }

    pub fn request_id(&self) -> Uuid {
        self.request_id
    }

    pub fn trace_id(&self) -> Option<&str> {
        self.trace_id.as_deref()
    }

    pub fn client_ip(&self) -> Option<IpAddr> {
        self.client_ip
    }
}

pub fn set_request_context(context: RequestContext) {
    CONTEXT.with(|cell| {
        *cell.borrow_mut() = Some(context);
    });
}

pub fn clear_request_context() {
    CONTEXT.with(|cell| {
        cell.borrow_mut().take();
    });
}

pub fn current_request_context() -> Option<RequestContext> {
    CONTEXT.with(|cell| cell.borrow().clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    #[test]
    fn round_trip_context() {
        clear_request_context();
        let ctx = RequestContext::new(Uuid::nil())
            .with_trace_id("trace")
            .with_client_ip(IpAddr::V4(Ipv4Addr::LOCALHOST));
        set_request_context(ctx.clone());

        let retrieved = match current_request_context() {
            Some(value) => value,
            None => panic!("expected request context to be set"),
        };
        assert_eq!(retrieved, ctx);
    }

    #[test]
    fn clearing_context_removes_value() {
        clear_request_context();
        set_request_context(RequestContext::new(Uuid::nil()));
        clear_request_context();
        assert!(current_request_context().is_none());
    }
}
