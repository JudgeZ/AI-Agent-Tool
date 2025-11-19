-- Initial schema for PostgreSQL with pgvector support
-- Migration: 001_initial_schema
-- Description: Create tables for symbols and documents with vector embeddings

-- Enable pgvector extension for similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- Symbols table with vector embeddings
CREATE TABLE IF NOT EXISTS symbols (
    id UUID PRIMARY KEY,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding vector(384), -- all-MiniLM-L6-v2 dimension (384) or text-embedding-ada-002 (1536)
    commit_id TEXT,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- HNSW index for fast vector similarity search
-- m: number of connections (higher = better recall, more memory)
-- ef_construction: size of dynamic candidate list (higher = better quality, slower build)
CREATE INDEX IF NOT EXISTS symbols_embedding_hnsw_idx ON symbols
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- B-tree indexes for filtering
CREATE INDEX IF NOT EXISTS symbols_path_idx ON symbols(path);
CREATE INDEX IF NOT EXISTS symbols_name_idx ON symbols(name);
CREATE INDEX IF NOT EXISTS symbols_kind_idx ON symbols(kind);
CREATE INDEX IF NOT EXISTS symbols_commit_idx ON symbols(commit_id);
CREATE INDEX IF NOT EXISTS symbols_created_at_idx ON symbols(created_at);

-- Composite index for path + name lookups
CREATE INDEX IF NOT EXISTS symbols_path_name_idx ON symbols(path, name);

-- GIN index for JSONB metadata searches
CREATE INDEX IF NOT EXISTS symbols_metadata_gin_idx ON symbols USING gin(metadata);

-- Documents table for full-file embeddings
CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    embedding vector(384),
    commit_id TEXT,
    language TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- HNSW index for document similarity
CREATE INDEX IF NOT EXISTS documents_embedding_hnsw_idx ON documents
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- B-tree indexes for documents
CREATE INDEX IF NOT EXISTS documents_path_idx ON documents(path);
CREATE INDEX IF NOT EXISTS documents_language_idx ON documents(language);
CREATE INDEX IF NOT EXISTS documents_commit_idx ON documents(commit_id);

-- Symbol versions table for tracking changes over time
CREATE TABLE IF NOT EXISTS symbol_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol_id UUID NOT NULL,
    commit_id TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    change_type TEXT NOT NULL CHECK (change_type IN ('added', 'modified', 'deleted', 'renamed')),
    author TEXT NOT NULL,
    commit_message TEXT NOT NULL,
    previous_path TEXT,
    content TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for symbol_versions
CREATE INDEX IF NOT EXISTS symbol_versions_symbol_id_idx ON symbol_versions(symbol_id);
CREATE INDEX IF NOT EXISTS symbol_versions_commit_id_idx ON symbol_versions(commit_id);
CREATE INDEX IF NOT EXISTS symbol_versions_timestamp_idx ON symbol_versions(timestamp DESC);

-- Symbol relationships table for tracking dependencies
CREATE TABLE IF NOT EXISTS symbol_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_symbol_id UUID NOT NULL,
    to_symbol_id UUID NOT NULL,
    relationship_type TEXT NOT NULL CHECK (relationship_type IN ('imports', 'calls', 'extends', 'implements', 'references')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(from_symbol_id, to_symbol_id, relationship_type)
);

-- Indexes for relationships
CREATE INDEX IF NOT EXISTS symbol_relationships_from_idx ON symbol_relationships(from_symbol_id);
CREATE INDEX IF NOT EXISTS symbol_relationships_to_idx ON symbol_relationships(to_symbol_id);
CREATE INDEX IF NOT EXISTS symbol_relationships_type_idx ON symbol_relationships(relationship_type);

-- Index statistics table
CREATE TABLE IF NOT EXISTS index_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    metric_name TEXT NOT NULL,
    metric_value NUMERIC NOT NULL,
    metadata JSONB,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS index_stats_name_idx ON index_stats(metric_name);
CREATE INDEX IF NOT EXISTS index_stats_recorded_at_idx ON index_stats(recorded_at DESC);

-- Function to update updated_at timestamp automatically
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers to auto-update updated_at
CREATE TRIGGER update_symbols_updated_at BEFORE UPDATE ON symbols
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_documents_updated_at BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to calculate cosine similarity (for reference, pgvector handles this)
CREATE OR REPLACE FUNCTION cosine_similarity(a vector, b vector)
RETURNS FLOAT AS $$
    SELECT 1 - (a <=> b);
$$ LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE;

-- View for symbol statistics
CREATE OR REPLACE VIEW symbol_stats AS
SELECT
    kind,
    COUNT(*) as count,
    AVG(end_line - start_line + 1) as avg_lines,
    MAX(end_line - start_line + 1) as max_lines,
    MIN(end_line - start_line + 1) as min_lines
FROM symbols
GROUP BY kind;

-- View for recent changes
CREATE OR REPLACE VIEW recent_symbol_changes AS
SELECT
    sv.symbol_id,
    s.name,
    s.path,
    s.kind,
    sv.change_type,
    sv.author,
    sv.timestamp,
    sv.commit_id
FROM symbol_versions sv
JOIN symbols s ON sv.symbol_id = s.id
ORDER BY sv.timestamp DESC
LIMIT 100;

-- Grant permissions (adjust as needed for your deployment)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO indexer_app;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO indexer_app;
-- GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO indexer_app;

-- Comments for documentation
COMMENT ON TABLE symbols IS 'Code symbols (functions, classes, etc.) with vector embeddings for semantic search';
COMMENT ON TABLE documents IS 'Full document contents with vector embeddings';
COMMENT ON TABLE symbol_versions IS 'Historical versions of symbols across git commits';
COMMENT ON TABLE symbol_relationships IS 'Relationships between symbols (imports, calls, etc.)';
COMMENT ON INDEX symbols_embedding_hnsw_idx IS 'HNSW index for fast approximate nearest neighbor search on symbol embeddings';
COMMENT ON INDEX documents_embedding_hnsw_idx IS 'HNSW index for fast approximate nearest neighbor search on document embeddings';
COMMENT ON FUNCTION cosine_similarity IS 'Calculate cosine similarity between two vectors (1 = identical, 0 = orthogonal, -1 = opposite)';
