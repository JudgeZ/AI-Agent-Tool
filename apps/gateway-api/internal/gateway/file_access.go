package gateway

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const DefaultMaxFileReadSize = 10 * 1024 * 1024 // 10MB

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
	f, err := filesystem.Open(rel)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		return nil, err
	}

	maxSize := getMaxFileSize()
	if stat.Size() > maxSize {
		return nil, fmt.Errorf("file too large (size %d, max %d bytes)", stat.Size(), maxSize)
	}

	// We read one byte more than the limit to detect if the file grew or is larger than reported
	r := io.LimitReader(f, maxSize+1)
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxSize {
		return nil, fmt.Errorf("file too large (max %d bytes)", maxSize)
	}

	return data, nil
}

func getMaxFileSize() int64 {
	val := os.Getenv("GATEWAY_MAX_FILE_READ_BYTES")
	if val == "" {
		return DefaultMaxFileReadSize
	}
	parsed, err := strconv.ParseInt(val, 10, 64)
	if err != nil || parsed <= 0 {
		return DefaultMaxFileReadSize
	}
	return parsed
}
