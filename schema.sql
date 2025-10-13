-- D1 Database Schema for Alegria Cache
-- This schema is used for caching CMS content and media metadata

-- Drop existing tables if they exist (for clean reinitialization)
DROP TABLE IF EXISTS page_cache;
DROP TABLE IF EXISTS media;

-- Page Cache Table
-- Stores cached responses from Payload CMS
CREATE TABLE page_cache (
    slug TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT,
    cache_hits INTEGER DEFAULT 0
);

-- Index for cache expiration queries
CREATE INDEX idx_page_cache_expires ON page_cache(expires_at);
CREATE INDEX idx_page_cache_updated ON page_cache(updated_at);

-- Media Table
-- Stores metadata about uploaded media files
CREATE TABLE media (
    key TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    size INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    last_accessed TEXT
);

-- Index for media queries
CREATE INDEX idx_media_uploaded ON media(uploaded_at);
CREATE INDEX idx_media_accessed ON media(last_accessed);

-- Cache Statistics Table (optional)
CREATE TABLE IF NOT EXISTS cache_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL,
    hits INTEGER DEFAULT 0,
    misses INTEGER DEFAULT 0,
    last_updated TEXT NOT NULL
);

CREATE INDEX idx_cache_stats_endpoint ON cache_stats(endpoint);
