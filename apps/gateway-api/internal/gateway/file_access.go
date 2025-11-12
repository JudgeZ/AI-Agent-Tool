package gateway

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// readFileFromAllowedRoot opens the provided path after constraining it to the
// supplied root directory. The helper defends against directory traversal by
// normalising both the root and requested path before using the Go 1.24 os.Root
// API to read the file contents.
func readFileFromAllowedRoot(path, rootDir string) ([]byte, error) {
	cleanedRoot := strings.TrimSpace(rootDir)
	if cleanedRoot == "" {
		cleanedRoot = "/"
	}
	cleanedRoot = filepath.Clean(cleanedRoot)

	cleanedPath := filepath.Clean(path)
	if !filepath.IsAbs(cleanedPath) {
		cleanedPath = filepath.Join(cleanedRoot, cleanedPath)
	}

	rel, err := filepath.Rel(cleanedRoot, cleanedPath)
	if err != nil {
		return nil, err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return nil, fmt.Errorf("file %q is outside allowed root %q", path, cleanedRoot)
	}

	root, err := os.OpenRoot(cleanedRoot)
	if err != nil {
		return nil, err
	}
	defer root.Close()

	file, err := root.Open(rel)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	return io.ReadAll(file)
}
