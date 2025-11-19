package sdk

import (
	"net/http"
	"time"
)

// Client is the main entry point for the OSS AI Agent Tool SDK.
type Client struct {
	BaseURL    string
	HTTPClient *http.Client
}

// NewClient creates a new Client instance.
func NewClient(baseURL string) *Client {
	return &Client{
		BaseURL: baseURL,
		HTTPClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

