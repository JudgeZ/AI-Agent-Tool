package gateway

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestCollaborationRouteRejectsMissingAuth(t *testing.T) {
	mux := http.NewServeMux()
	RegisterCollaborationRoutes(mux)

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/collaboration/ws"
	_, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err == nil {
		t.Fatalf("expected dial to fail without auth, got response: %+v", resp)
	}
	if resp == nil {
		t.Fatalf("expected HTTP response, got nil")
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 status, got %d", resp.StatusCode)
	}
}

func TestCollaborationRouteProxiesWebsocket(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	orchestrator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/collaboration/ws" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Fatalf("upgrade failed: %v", err)
		}
		defer conn.Close()
		if err := conn.WriteMessage(websocket.TextMessage, []byte("ok")); err != nil {
			t.Fatalf("failed to write message: %v", err)
		}
	}))
	defer orchestrator.Close()

	t.Setenv("ORCHESTRATOR_URL", orchestrator.URL)
	ResetOrchestratorClient()
	mux := http.NewServeMux()
	RegisterCollaborationRoutes(mux)

	gateway := httptest.NewServer(mux)
	defer gateway.Close()

	wsURL := "ws" + strings.TrimPrefix(gateway.URL, "http") + "/collaboration/ws"
	headers := http.Header{}
	headers.Set("Authorization", "Bearer test-token")

	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, headers)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	defer conn.Close()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("expected 101 response, got %d", resp.StatusCode)
	}

	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, message, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("failed to read message: %v", err)
	}
	if string(message) != "ok" {
		t.Fatalf("unexpected message: %s", string(message))
	}
}
