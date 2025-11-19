-- Migration: Create Marketplace Tables
-- Version: 001
-- Description: Initial marketplace schema for tool listings, publishers, and reviews

-- Create publishers table
CREATE TABLE IF NOT EXISTS marketplace_publishers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    verified BOOLEAN DEFAULT false,
    reputation_score INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, user_id)
);

-- Create tool listings table
CREATE TABLE IF NOT EXISTS marketplace_listings (
    id VARCHAR(255) PRIMARY KEY, -- Tool ID like 'com.example.tool'
    publisher_id UUID NOT NULL REFERENCES marketplace_publishers(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    version_major INTEGER NOT NULL,
    version_minor INTEGER NOT NULL,
    version_patch INTEGER NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'draft', -- draft, pending_review, published, deprecated, archived
    manifest JSONB NOT NULL, -- Full tool manifest
    package_url TEXT,
    license VARCHAR(100),
    tags TEXT[], -- Array of tags
    capabilities TEXT[], -- Array of capability strings
    downloads INTEGER DEFAULT 0,
    rating_average DECIMAL(2,1) DEFAULT 0.0,
    rating_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    published_at TIMESTAMP WITH TIME ZONE,
    deprecated_at TIMESTAMP WITH TIME ZONE
);

-- Create security scan results table
CREATE TABLE IF NOT EXISTS marketplace_security_scans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id VARCHAR(255) NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    scan_status VARCHAR(50) NOT NULL, -- pending, passed, failed, error
    scanned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    scanner_version VARCHAR(50),
    findings JSONB, -- Array of security findings
    summary JSONB, -- Summary counts by severity
    metadata JSONB -- Additional scan metadata
);

-- Create tool reviews table
CREATE TABLE IF NOT EXISTS marketplace_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id VARCHAR(255) NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    reviewer_id VARCHAR(255) NOT NULL,
    reviewer_name VARCHAR(255),
    tenant_id VARCHAR(255) NOT NULL,
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    title VARCHAR(255),
    comment TEXT,
    helpful_count INTEGER DEFAULT 0,
    verified_purchase BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(listing_id, reviewer_id, tenant_id)
);

-- Create download history table for analytics
CREATE TABLE IF NOT EXISTS marketplace_downloads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id VARCHAR(255) NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    tenant_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(255),
    version VARCHAR(20) NOT NULL,
    downloaded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    ip_address INET,
    user_agent TEXT
);

-- Create featured tools table
CREATE TABLE IF NOT EXISTS marketplace_featured (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id VARCHAR(255) NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    category VARCHAR(100), -- 'trending', 'new', 'popular', 'editors_choice'
    priority INTEGER DEFAULT 0,
    featured_from TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    featured_until TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(listing_id, category)
);

-- Indexes for performance
CREATE INDEX idx_marketplace_listings_status ON marketplace_listings(status);
CREATE INDEX idx_marketplace_listings_publisher ON marketplace_listings(publisher_id);
CREATE INDEX idx_marketplace_listings_tags ON marketplace_listings USING GIN(tags);
CREATE INDEX idx_marketplace_listings_capabilities ON marketplace_listings USING GIN(capabilities);
CREATE INDEX idx_marketplace_listings_downloads ON marketplace_listings(downloads DESC);
CREATE INDEX idx_marketplace_listings_rating ON marketplace_listings(rating_average DESC, rating_count DESC);
CREATE INDEX idx_marketplace_listings_created ON marketplace_listings(created_at DESC);
CREATE INDEX idx_marketplace_listings_search ON marketplace_listings USING GIN(
    to_tsvector('english', name || ' ' || COALESCE(description, ''))
);

CREATE INDEX idx_marketplace_reviews_listing ON marketplace_reviews(listing_id);
CREATE INDEX idx_marketplace_reviews_reviewer ON marketplace_reviews(reviewer_id, tenant_id);

CREATE INDEX idx_marketplace_downloads_listing ON marketplace_downloads(listing_id);
CREATE INDEX idx_marketplace_downloads_tenant ON marketplace_downloads(tenant_id);
CREATE INDEX idx_marketplace_downloads_time ON marketplace_downloads(downloaded_at DESC);

CREATE INDEX idx_marketplace_security_scans_listing ON marketplace_security_scans(listing_id);
CREATE INDEX idx_marketplace_security_scans_status ON marketplace_security_scans(scan_status);

CREATE INDEX idx_marketplace_featured_category ON marketplace_featured(category);
CREATE INDEX idx_marketplace_featured_active ON marketplace_featured(featured_from, featured_until);

-- Update triggers for updated_at columns
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_marketplace_publishers_updated_at
    BEFORE UPDATE ON marketplace_publishers
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_marketplace_listings_updated_at
    BEFORE UPDATE ON marketplace_listings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_marketplace_reviews_updated_at
    BEFORE UPDATE ON marketplace_reviews
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Function to update listing ratings when reviews change
CREATE OR REPLACE FUNCTION update_listing_ratings()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        UPDATE marketplace_listings
        SET rating_average = COALESCE((
            SELECT AVG(rating)::DECIMAL(2,1)
            FROM marketplace_reviews
            WHERE listing_id = OLD.listing_id
        ), 0.0),
        rating_count = (
            SELECT COUNT(*)
            FROM marketplace_reviews
            WHERE listing_id = OLD.listing_id
        )
        WHERE id = OLD.listing_id;
        RETURN OLD;
    ELSE
        UPDATE marketplace_listings
        SET rating_average = COALESCE((
            SELECT AVG(rating)::DECIMAL(2,1)
            FROM marketplace_reviews
            WHERE listing_id = NEW.listing_id
        ), 0.0),
        rating_count = (
            SELECT COUNT(*)
            FROM marketplace_reviews
            WHERE listing_id = NEW.listing_id
        )
        WHERE id = NEW.listing_id;
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_ratings_on_review_change
    AFTER INSERT OR UPDATE OR DELETE ON marketplace_reviews
    FOR EACH ROW
    EXECUTE FUNCTION update_listing_ratings();
