package tracing

import (
	"context"
	"testing"
)

func TestInitReturnsNoopShutdown(t *testing.T) {
	shutdown, err := Init(context.Background())
	if err != nil {
		t.Fatalf("Init returned error: %v", err)
	}
	if shutdown == nil {
		t.Fatal("expected shutdown function to be non-nil")
	}

	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown returned error: %v", err)
	}

	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown should remain a no-op on subsequent calls: %v", err)
	}
}
