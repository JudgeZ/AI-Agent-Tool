package gateway

import (
	"crypto/tls"
	"net/http"
	"path/filepath"
	"testing"
)

func TestBuildOrchestratorClientWithoutTLS(t *testing.T) {
	t.Setenv("ORCHESTRATOR_TLS_ENABLED", "0")
	client, err := buildOrchestratorClient()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	transport := unwrapHTTPTransport(t, client.Transport)
	if transport.TLSClientConfig != nil && len(transport.TLSClientConfig.Certificates) > 0 {
		t.Fatal("expected no client certificates when TLS disabled")
	}
}

func TestBuildOrchestratorClientRequiresKeyMaterial(t *testing.T) {
	t.Setenv("ORCHESTRATOR_TLS_ENABLED", "true")
	t.Setenv("ORCHESTRATOR_CLIENT_CERT", "cert.pem")
	t.Setenv("ORCHESTRATOR_CLIENT_KEY", "")

	if _, err := buildOrchestratorClient(); err == nil {
		t.Fatal("expected error when TLS enabled without key material")
	}
}

func TestBuildOrchestratorClientConfiguresMutualTLS(t *testing.T) {
	t.Setenv("ORCHESTRATOR_TLS_ENABLED", "true")
	certPath := filepath.Join(t.TempDir(), "client.crt")
	keyPath := filepath.Join(t.TempDir(), "client.key")
	t.Setenv("ORCHESTRATOR_CLIENT_CERT", certPath)
	t.Setenv("ORCHESTRATOR_CLIENT_KEY", keyPath)
	t.Setenv("ORCHESTRATOR_TLS_SERVER_NAME", "orchestrator.internal")

	originalLoader := loadClientCertificate
	defer func() { loadClientCertificate = originalLoader }()

	var loadedCertPath, loadedKeyPath string
	loadClientCertificate = func(certFile, keyFile string) (tls.Certificate, error) {
		loadedCertPath = certFile
		loadedKeyPath = keyFile
		return tls.Certificate{Certificate: [][]byte{{1}}}, nil
	}

	client, err := buildOrchestratorClient()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if loadedCertPath != certPath {
		t.Fatalf("expected cert path %s, got %s", certPath, loadedCertPath)
	}
	if loadedKeyPath != keyPath {
		t.Fatalf("expected key path %s, got %s", keyPath, loadedKeyPath)
	}

	transport := unwrapHTTPTransport(t, client.Transport)

	tlsConfig := transport.TLSClientConfig
	if tlsConfig == nil {
		t.Fatal("expected TLS config to be populated")
	}
	if len(tlsConfig.Certificates) != 1 {
		t.Fatalf("expected exactly one certificate, got %d", len(tlsConfig.Certificates))
	}
	if tlsConfig.ServerName != "orchestrator.internal" {
		t.Fatalf("unexpected server name: %s", tlsConfig.ServerName)
	}
	if tlsConfig.MinVersion != tls.VersionTLS12 {
		t.Fatalf("expected TLS v1.2 minimum, got %d", tlsConfig.MinVersion)
	}
}

type transportWithBase interface {
	Base() *http.Transport
}

func unwrapHTTPTransport(t *testing.T, transport http.RoundTripper) *http.Transport {
	t.Helper()

	if withBase, ok := transport.(transportWithBase); ok {
		return withBase.Base()
	}

	if base, ok := transport.(*http.Transport); ok {
		return base
	}

	t.Fatalf("expected transport exposing Base() or *http.Transport, got %T", transport)
	return nil
}
