package gateway

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

var (
	orchestratorClientOnce    sync.Once
	orchestratorClient        *http.Client
	orchestratorClientErr     error
	orchestratorClientFactory = buildOrchestratorClient
	loadClientCertificate     = tls.LoadX509KeyPair
)

func getOrchestratorClient() (*http.Client, error) {
	orchestratorClientOnce.Do(func() {
		orchestratorClient, orchestratorClientErr = orchestratorClientFactory()
	})
	return orchestratorClient, orchestratorClientErr
}

func buildOrchestratorClient() (*http.Client, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 30 * time.Second

	if getBoolEnv("ORCHESTRATOR_TLS_ENABLED") {
		clientCertPath := strings.TrimSpace(os.Getenv("ORCHESTRATOR_CLIENT_CERT"))
		clientKeyPath := strings.TrimSpace(os.Getenv("ORCHESTRATOR_CLIENT_KEY"))
		if clientCertPath == "" || clientKeyPath == "" {
			return nil, fmt.Errorf("ORCHESTRATOR_TLS_ENABLED=true requires ORCHESTRATOR_CLIENT_CERT and ORCHESTRATOR_CLIENT_KEY to be set")
		}

		certificate, err := loadClientCertificate(clientCertPath, clientKeyPath)
		if err != nil {
			return nil, fmt.Errorf("failed to load orchestrator client certificate: %w", err)
		}

		tlsConfig := &tls.Config{
			MinVersion:   tls.VersionTLS12,
			Certificates: []tls.Certificate{certificate},
		}

		if caPath := strings.TrimSpace(os.Getenv("ORCHESTRATOR_CA_CERT")); caPath != "" {
			caData, err := os.ReadFile(caPath)
			if err != nil {
				return nil, fmt.Errorf("failed to read orchestrator CA certificate: %w", err)
			}
			roots := x509.NewCertPool()
			if !roots.AppendCertsFromPEM(caData) {
				return nil, fmt.Errorf("failed to parse orchestrator CA certificate")
			}
			tlsConfig.RootCAs = roots
		}

		if serverName := strings.TrimSpace(os.Getenv("ORCHESTRATOR_TLS_SERVER_NAME")); serverName != "" {
			tlsConfig.ServerName = serverName
		}

		transport.TLSClientConfig = tlsConfig
	}

	return &http.Client{Transport: transport}, nil
}

func SetOrchestratorClientFactory(factory func() (*http.Client, error)) {
	orchestratorClientFactory = factory
	resetOrchestratorClient()
}

func ResetOrchestratorClient() {
	orchestratorClientFactory = buildOrchestratorClient
	resetOrchestratorClient()
}

func resetOrchestratorClient() {
	orchestratorClientOnce = sync.Once{}
	orchestratorClient = nil
	orchestratorClientErr = nil
}

func getBoolEnv(key string) bool {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return false
	}
	switch strings.ToLower(value) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
