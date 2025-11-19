-- Migration: Add vector support for semantic search
-- Requires: PostgreSQL with pgvector extension
-- Version: 0.5.0 or later of pgvector

-- Enable the pgvector extension if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding vector column to documents table
-- Using 384 dimensions (for all-MiniLM-L6-v2)
ALTER TABLE documents
ADD COLUMN IF NOT EXISTS embedding_vector vector(384);

-- Add embedding vector column to symbols table (optional, for symbol-level embeddings)
ALTER TABLE symbols
ADD COLUMN IF NOT EXISTS embedding_vector vector(384);

-- Create indexes for fast similarity search using IVFFlat algorithm
-- IVFFlat is faster for large datasets but requires training data
-- Lists parameter controls the number of clusters (typically sqrt(rows))
-- Start with 100 lists, adjust based on data size
CREATE INDEX IF NOT EXISTS idx_documents_embedding
ON documents USING ivfflat (embedding_vector vector_cosine_ops)
WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_symbols_embedding
ON symbols USING ivfflat (embedding_vector vector_cosine_ops)
WITH (lists = 100);

-- Add metadata columns to track embedding generation
ALTER TABLE documents
ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(255),
ADD COLUMN IF NOT EXISTS embedding_generated_at TIMESTAMPTZ;

ALTER TABLE symbols
ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(255),
ADD COLUMN IF NOT EXISTS embedding_generated_at TIMESTAMPTZ;

-- Create a helper function to calculate cosine similarity (if needed for queries)
-- Note: pgvector already provides operators, but this can be useful for debugging
CREATE OR REPLACE FUNCTION cosine_similarity(a vector, b vector)
RETURNS float
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
AS $$
    SELECT 1 - (a <=> b);
$$;

-- Create a view for documents with embeddings (useful for monitoring)
CREATE OR REPLACE VIEW documents_with_embeddings AS
SELECT
    id,
    path,
    LENGTH(content) as content_length,
    embedding_model,
    embedding_generated_at,
    CASE
        WHEN embedding_vector IS NOT NULL THEN 'yes'
        ELSE 'no'
    END as has_embedding,
    created_at,
    updated_at
FROM documents;

-- Create a view for symbols with embeddings
CREATE OR REPLACE VIEW symbols_with_embeddings AS
SELECT
    id,
    path,
    name,
    kind,
    embedding_model,
    embedding_generated_at,
    CASE
        WHEN embedding_vector IS NOT NULL THEN 'yes'
        ELSE 'no'
    END as has_embedding,
    created_at,
    updated_at
FROM symbols;

-- Add comments for documentation
COMMENT ON COLUMN documents.embedding_vector IS 'Vector embedding for semantic search (384 dimensions)';
COMMENT ON COLUMN documents.embedding_model IS 'Name/version of the embedding model used';
COMMENT ON COLUMN documents.embedding_generated_at IS 'Timestamp when the embedding was generated';
COMMENT ON COLUMN symbols.embedding_vector IS 'Vector embedding for semantic symbol search (384 dimensions)';
COMMENT ON COLUMN symbols.embedding_model IS 'Name/version of the embedding model used';
COMMENT ON COLUMN symbols.embedding_generated_at IS 'Timestamp when the embedding was generated';

COMMENT ON FUNCTION cosine_similarity IS 'Calculate cosine similarity between two vectors (higher = more similar)';

-- Grant permissions (adjust as needed for your deployment)
-- GRANT SELECT, UPDATE ON documents TO indexer_service;
-- GRANT SELECT, UPDATE ON symbols TO indexer_service;
