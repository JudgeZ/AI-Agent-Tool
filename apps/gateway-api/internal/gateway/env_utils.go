package gateway

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

func GetEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func GetIntEnv(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	if value < 0 {
		return 0
	}
	return value
}

func ResolveEnvValue(key string) (string, error) {
	fileKey := key + "_FILE"
	if path := strings.TrimSpace(os.Getenv(fileKey)); path != "" {
		data, err := ReadSecretFile(path)
		if err != nil {
			return "", fmt.Errorf("failed to read %s: %w", fileKey, err)
		}
		value := strings.TrimSpace(string(data))
		if value != "" {
			return value, nil
		}
		return "", nil
	}
	value := strings.TrimSpace(os.Getenv(key))
	if value != "" {
		return value, nil
	}
	return "", nil
}

func ReadSecretFile(path string) ([]byte, error) {
	rootDir := strings.TrimSpace(os.Getenv("GATEWAY_SECRET_FILE_ROOT"))
	return readFileFromAllowedRoot(path, rootDir)
}

func ResolveDuration(keys []string, fallback time.Duration) time.Duration {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			if dur, err := time.ParseDuration(value); err == nil && dur > 0 {
				return dur
			}
		}
	}
	return fallback
}

func ResolveLimit(keys []string, fallback int) int {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			if limit, err := strconv.Atoi(value); err == nil && limit > 0 {
				return limit
			}
		}
	}
	if fallback <= 0 {
		return 1
	}
	return fallback
}

func GetDurationEnv(key string, fallback time.Duration) time.Duration {
	if value := os.Getenv(key); value != "" {
		dur, err := time.ParseDuration(value)
		if err == nil {
			return dur
		}
	}
	return fallback
}
