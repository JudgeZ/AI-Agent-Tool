package gateway

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestCollaborationProxyPreservesQuery(t *testing.T) {
	target, err := url.Parse("http://orchestrator:4000")
	if err != nil {
		t.Fatalf("failed to parse target: %v", err)
	}

	proxy := newCollaborationProxy(target)

	req := httptest.NewRequest(http.MethodGet, "http://gateway.local/collaboration/ws?filePath=example.txt", nil)
	proxy.Director(req)

	if req.URL.Path != "/collaboration/ws" {
		t.Fatalf("expected path to be preserved, got %s", req.URL.Path)
	}

	if got := req.URL.RawQuery; got != "filePath=example.txt" {
		t.Fatalf("expected query to be preserved, got %q", got)
	}
}
