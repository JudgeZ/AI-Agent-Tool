package gateway

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadFileFromAllowedRoot(t *testing.T) {
	// Create a temporary directory for testing
	tmpDir := t.TempDir()

	// Create test files
	smallFile := filepath.Join(tmpDir, "small.txt")
	if err := os.WriteFile(smallFile, []byte("small content"), 0644); err != nil {
		t.Fatalf("Failed to create small test file: %v", err)
	}

	largeContent := strings.Repeat("x", 11*1024*1024) // 11MB
	largeFile := filepath.Join(tmpDir, "large.txt")
	if err := os.WriteFile(largeFile, []byte(largeContent), 0644); err != nil {
		t.Fatalf("Failed to create large test file: %v", err)
	}

	t.Run("reads file within size limit", func(t *testing.T) {
		content, err := readFileFromAllowedRoot("small.txt", tmpDir)
		if err != nil {
			t.Errorf("Expected no error, got: %v", err)
		}
		if string(content) != "small content" {
			t.Errorf("Expected 'small content', got: %q", content)
		}
	})

	t.Run("rejects file exceeding size limit", func(t *testing.T) {
		_, err := readFileFromAllowedRoot("large.txt", tmpDir)
		if err == nil {
			t.Error("Expected error for large file, got nil")
		}
		if !strings.Contains(err.Error(), "file too large") {
			t.Errorf("Expected 'file too large' error, got: %v", err)
		}
	})

	t.Run("prevents directory traversal", func(t *testing.T) {
		_, err := readFileFromAllowedRoot("../../../etc/passwd", tmpDir)
		if err == nil {
			t.Error("Expected error for traversal attempt, got nil")
		}
		if !strings.Contains(err.Error(), "outside allowed root") {
			t.Errorf("Expected 'outside allowed root' error, got: %v", err)
		}
	})

	t.Run("rejects non-existent file", func(t *testing.T) {
		_, err := readFileFromAllowedRoot("nonexistent.txt", tmpDir)
		if err == nil {
			t.Error("Expected error for non-existent file, got nil")
		}
	})
}

func TestGetMaxFileSize(t *testing.T) {
	// Save original env var to restore later
	originalVal := os.Getenv("GATEWAY_MAX_FILE_READ_BYTES")
	defer func() {
		if originalVal != "" {
			os.Setenv("GATEWAY_MAX_FILE_READ_BYTES", originalVal)
		} else {
			os.Unsetenv("GATEWAY_MAX_FILE_READ_BYTES")
		}
	}()

	tests := []struct {
		name     string
		envValue string
		expected int64
	}{
		{
			name:     "uses default when env var not set",
			envValue: "",
			expected: DefaultMaxFileReadSize,
		},
		{
			name:     "uses custom value from env var",
			envValue: "5242880", // 5MB
			expected: 5242880,
		},
		{
			name:     "falls back to default on invalid value",
			envValue: "invalid",
			expected: DefaultMaxFileReadSize,
		},
		{
			name:     "falls back to default on negative value",
			envValue: "-1",
			expected: DefaultMaxFileReadSize,
		},
		{
			name:     "falls back to default on zero value",
			envValue: "0",
			expected: DefaultMaxFileReadSize,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.envValue == "" {
				os.Unsetenv("GATEWAY_MAX_FILE_READ_BYTES")
			} else {
				os.Setenv("GATEWAY_MAX_FILE_READ_BYTES", tt.envValue)
			}

			result := getMaxFileSize()
			if result != tt.expected {
				t.Errorf("Expected %d, got %d", tt.expected, result)
			}
		})
	}
}

func TestReadFileFromAllowedRoot_WithCustomSizeLimit(t *testing.T) {
	// Save and restore env var
	originalVal := os.Getenv("GATEWAY_MAX_FILE_READ_BYTES")
	defer func() {
		if originalVal != "" {
			os.Setenv("GATEWAY_MAX_FILE_READ_BYTES", originalVal)
		} else {
			os.Unsetenv("GATEWAY_MAX_FILE_READ_BYTES")
		}
	}()

	// Set custom limit to 1KB
	os.Setenv("GATEWAY_MAX_FILE_READ_BYTES", "1024")

	tmpDir := t.TempDir()

	// Create a file slightly under 1KB
	smallContent := strings.Repeat("a", 1000)
	smallFile := filepath.Join(tmpDir, "small.txt")
	if err := os.WriteFile(smallFile, []byte(smallContent), 0644); err != nil {
		t.Fatalf("Failed to create small test file: %v", err)
	}

	// Create a file over 1KB
	largeContent := strings.Repeat("b", 2000)
	largeFile := filepath.Join(tmpDir, "large.txt")
	if err := os.WriteFile(largeFile, []byte(largeContent), 0644); err != nil {
		t.Fatalf("Failed to create large test file: %v", err)
	}

	t.Run("reads file under custom limit", func(t *testing.T) {
		content, err := readFileFromAllowedRoot("small.txt", tmpDir)
		if err != nil {
			t.Errorf("Expected no error, got: %v", err)
		}
		if len(content) != 1000 {
			t.Errorf("Expected 1000 bytes, got: %d", len(content))
		}
	})

	t.Run("rejects file over custom limit", func(t *testing.T) {
		_, err := readFileFromAllowedRoot("large.txt", tmpDir)
		if err == nil {
			t.Error("Expected error for file exceeding custom limit, got nil")
		}
		if !strings.Contains(err.Error(), "file too large") {
			t.Errorf("Expected 'file too large' error, got: %v", err)
		}
		if !strings.Contains(err.Error(), "max 1024 bytes") {
			t.Errorf("Expected error to mention limit of 1024 bytes, got: %v", err)
		}
	})
}

func TestReadFileFromAllowedRoot_ExactlyAtLimit(t *testing.T) {
	// Save and restore env var
	originalVal := os.Getenv("GATEWAY_MAX_FILE_READ_BYTES")
	defer func() {
		if originalVal != "" {
			os.Setenv("GATEWAY_MAX_FILE_READ_BYTES", originalVal)
		} else {
			os.Unsetenv("GATEWAY_MAX_FILE_READ_BYTES")
		}
	}()

	// Set limit to exactly 1KB
	os.Setenv("GATEWAY_MAX_FILE_READ_BYTES", "1024")

	tmpDir := t.TempDir()

	// Create a file exactly at the limit
	exactContent := strings.Repeat("c", 1024)
	exactFile := filepath.Join(tmpDir, "exact.txt")
	if err := os.WriteFile(exactFile, []byte(exactContent), 0644); err != nil {
		t.Fatalf("Failed to create exact-size test file: %v", err)
	}

	t.Run("reads file exactly at limit", func(t *testing.T) {
		content, err := readFileFromAllowedRoot("exact.txt", tmpDir)
		if err != nil {
			t.Errorf("Expected no error for file at exact limit, got: %v", err)
		}
		if len(content) != 1024 {
			t.Errorf("Expected 1024 bytes, got: %d", len(content))
		}
	})

	// Create a file one byte over the limit
	overContent := strings.Repeat("d", 1025)
	overFile := filepath.Join(tmpDir, "over.txt")
	if err := os.WriteFile(overFile, []byte(overContent), 0644); err != nil {
		t.Fatalf("Failed to create over-limit test file: %v", err)
	}

	t.Run("rejects file one byte over limit", func(t *testing.T) {
		_, err := readFileFromAllowedRoot("over.txt", tmpDir)
		if err == nil {
			t.Error("Expected error for file one byte over limit, got nil")
		}
		if !strings.Contains(err.Error(), "file too large") {
			t.Errorf("Expected 'file too large' error, got: %v", err)
		}
	})
}
