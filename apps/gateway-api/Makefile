# Gateway API Makefile

.PHONY: test test-coverage test-coverage-filtered test-integration clean help

# Default target
all: test

# Run tests
test:
	@echo "Running tests..."
	@go test ./...

# Run tests with coverage (including generated files)
test-coverage:
	@echo "Running tests with coverage..."
	@go test ./... -coverprofile=coverage.out
	@echo "\n=== Coverage Report (Including Generated Files) ==="
	@go tool cover -func=coverage.out | tail -1

# Run tests with coverage (excluding .pb.go files)
test-coverage-filtered:
	@echo "Running tests with coverage (excluding protobuf files)..."
	@go test ./... -coverprofile=coverage.out
	@grep -v "\.pb\.go:" coverage.out > coverage-filtered.out || true
	@echo "\n=== Coverage Report (Excluding Generated Files) ==="
	@go tool cover -func=coverage-filtered.out | tail -1
	@echo "\n=== Coverage by Package (Excluding Generated Files) ==="
	@go tool cover -func=coverage-filtered.out | grep -E "^github.com/OSS-AI-Agent-Tool.*:" | awk '{printf "%-80s %s\n", $$1, $$NF}' | head -10

# Run integration tests
test-integration:
	@echo "Running integration tests..."
	@go test ./... -tags=integration -coverprofile=coverage.out
	@grep -v "\.pb\.go:" coverage.out > coverage-filtered.out || true
	@echo "\n=== Integration Test Coverage (Excluding Generated Files) ==="
	@go tool cover -func=coverage-filtered.out | tail -1

# Generate HTML coverage report
coverage-html: test-coverage-filtered
	@echo "Generating HTML coverage report..."
	@go tool cover -html=coverage-filtered.out -o coverage.html
	@echo "Coverage report generated: coverage.html"

# Clean up coverage files
clean:
	@echo "Cleaning up..."
	@rm -f coverage.out coverage-filtered.out coverage.html

# Show help
help:
	@echo "Gateway API Makefile"
	@echo ""
	@echo "Usage:"
	@echo "  make test                    Run all tests"
	@echo "  make test-coverage           Run tests with coverage (includes generated files)"
	@echo "  make test-coverage-filtered  Run tests with coverage (excludes .pb.go files)"
	@echo "  make test-integration        Run integration tests with coverage"
	@echo "  make coverage-html           Generate HTML coverage report"
	@echo "  make clean                   Clean up coverage files"
	@echo "  make help                    Show this help message"
	@echo ""
	@echo "Current Coverage Status:"
	@echo "  - With generated files: 73.7%"
	@echo "  - Without generated files: 76.9%"
	@echo "  - Target: 80%"
