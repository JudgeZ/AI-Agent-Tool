package gateway

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// readFileFromAllowedRoot opens the provided path after constraining it to the
// supplied root directory. The helper defends against directory traversal by
// normalising both the root and requested path before using an os.DirFS-based
// reader to load the file contents.
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

	filesystem := os.DirFS(cleanedRoot)
	return fs.ReadFile(filesystem, rel)
}
