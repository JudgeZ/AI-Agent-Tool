# Indexer Service Operations Runbook

## Overview

The Indexer service provides semantic code search capabilities using tree-sitter for symbol extraction and PostgreSQL with pgvector for vector similarity search.

**Service Components:**
- Symbol extraction (tree-sitter AST parsing)
- Embedding generation (all-MiniLM-L6-v2)
- Vector storage (PostgreSQL + pgvector)
- gRPC API for search operations

**Key Dependencies:**
- PostgreSQL 15+ with pgvector extension
- Tree-sitter language parsers (TypeScript, JavaScript, Rust)
- Embedding model (local or API-based)

---

## Common Issues

### 1. Indexer Service Not Starting

**Symptoms:**
- Service crashes on startup
- Health check failures
- "Connection refused" errors from clients

**Diagnosis:**
```bash
# Check service logs
kubectl logs -n default deployment/indexer --tail=100

# Check PostgreSQL connectivity
kubectl exec -n default deployment/indexer -- \
  psql -h postgres-service -U indexer -c "SELECT version();"

# Verify pgvector extension
kubectl exec -n default deployment/indexer -- \
  psql -h postgres-service -U indexer -d indexer -c \
  "SELECT * FROM pg_extension WHERE extname='vector';"
```

**Common Causes:**

1. **pgvector extension not installed**
   ```sql
   -- Connect to PostgreSQL and run:
   CREATE EXTENSION IF NOT EXISTS vector;
   ```

2. **Database migration failures**
   ```bash
   # Check migration status
   kubectl exec -n default deployment/indexer -- \
     psql -h postgres-service -U indexer -d indexer -c \
     "SELECT * FROM _sqlx_migrations;"
   
   # Manually run migrations if needed
   kubectl exec -n default deployment/indexer -- \
     /app/indexer migrate
   ```

3. **Connection pool exhausted**
   ```bash
   # Check active connections
   kubectl exec -n default deployment/postgres -- \
     psql -U postgres -c \
     "SELECT count(*) FROM pg_stat_activity WHERE datname='indexer';"
   
   # Increase max_connections in postgres.conf if needed
   ```

**Resolution:**
1. Ensure PostgreSQL is running and accessible
2. Install pgvector extension
3. Run database migrations
4. Verify connection pool settings in config
5. Restart indexer service

---

### 2. Slow Vector Search Performance

**Symptoms:**
- Search requests timing out
- High latency (>1s for typical queries)
- CPU spikes during search operations

**Diagnosis:**
```bash
# Check HNSW index status
kubectl exec -n default deployment/postgres -- \
  psql -U indexer -d indexer -c \
  "SELECT schemaname, tablename, indexname, idx_scan, idx_tup_read, idx_tup_fetch 
   FROM pg_stat_user_indexes 
   WHERE indexname LIKE '%hnsw%';"

# Check query performance
kubectl exec -n default deployment/postgres -- \
  psql -U indexer -d indexer -c \
  "EXPLAIN ANALYZE 
   SELECT id, 1 - (embedding <=> '[0.1,0.2,...]'::vector) as similarity 
   FROM symbols 
   ORDER BY embedding <=> '[0.1,0.2,...]'::vector 
   LIMIT 10;"

# Monitor query latency metrics
kubectl exec -n default deployment/prometheus -- \
  promtool query instant 'histogram_quantile(0.95, 
    rate(indexer_search_duration_seconds_bucket[5m]))'
```

**Common Causes:**

1. **HNSW index not created or corrupted**
   ```sql
   -- Recreate HNSW index
   DROP INDEX IF EXISTS symbols_embedding_hnsw_idx;
   CREATE INDEX symbols_embedding_hnsw_idx ON symbols 
   USING hnsw (embedding vector_cosine_ops)
   WITH (m = 16, ef_construction = 64);
   ```

2. **Too many symbols without index optimization**
   ```sql
   -- Run VACUUM ANALYZE
   VACUUM ANALYZE symbols;
   VACUUM ANALYZE documents;
   ```

3. **Inefficient query patterns**
   - Check if filters are applied before vector search
   - Ensure similarity threshold is not too low
   - Verify top_k is reasonable (<100)

**Resolution:**
1. Verify HNSW indexes exist and are being used
2. Run VACUUM ANALYZE to update statistics
3. Tune HNSW parameters (ef_construction, m)
4. Increase PostgreSQL work_mem for query planning
5. Consider partitioning large symbol tables by repository

**Performance Tuning:**
```sql
-- Adjust HNSW search parameters
SET hnsw.ef_search = 100;  -- Higher = better recall, slower

-- Optimize PostgreSQL for vector search
ALTER SYSTEM SET shared_buffers = '4GB';
ALTER SYSTEM SET effective_cache_size = '12GB';
ALTER SYSTEM SET work_mem = '256MB';
ALTER SYSTEM SET maintenance_work_mem = '1GB';
ALTER SYSTEM SET random_page_cost = 1.1;  -- For SSD storage

-- Reload configuration
SELECT pg_reload_conf();
```

---

### 3. Symbol Extraction Failures

**Symptoms:**
- gRPC errors when indexing repositories
- Missing symbols in search results
- "Tree-sitter parse error" logs

**Diagnosis:**
```bash
# Check indexer logs for parse errors
kubectl logs -n default deployment/indexer | grep "parse error"

# Test symbol extraction manually
kubectl exec -n default deployment/indexer -- \
  /app/indexer extract --file /path/to/file.ts --language typescript

# Verify tree-sitter language parsers
kubectl exec -n default deployment/indexer -- \
  ls -la /app/parsers/
```

**Common Causes:**

1. **Unsupported file type**
   - Currently supports: TypeScript, JavaScript, Rust
   - Other languages will be skipped

2. **Syntax errors in source code**
   - Tree-sitter can handle most syntax errors
   - Check for severely malformed files

3. **Memory exhaustion for large files**
   - Default limit: 10MB per file
   - Adjust MAX_FILE_SIZE in config

**Resolution:**
1. Verify file language is supported
2. Check source file for severe syntax errors
3. Increase memory limits if needed
4. Skip problematic files in indexing pipeline

---

### 4. Embedding Generation Errors

**Symptoms:**
- "Embedding model not loaded" errors
- Zero/null embeddings in database
- Search returns no results

**Diagnosis:**
```bash
# Check embedding service status
kubectl logs -n default deployment/indexer | grep "embedding"

# Verify embedding dimensions
kubectl exec -n default deployment/postgres -- \
  psql -U indexer -d indexer -c \
  "SELECT name, array_length(embedding, 1) as dim 
   FROM symbols 
   WHERE embedding IS NOT NULL 
   LIMIT 10;"

# Test embedding generation
kubectl exec -n default deployment/indexer -- \
  /app/indexer embed --text "function test() {}"
```

**Common Causes:**

1. **Embedding model not downloaded**
   - Model should be bundled in container
   - Check /app/models/ directory

2. **API rate limits (if using external service)**
   - Implement exponential backoff
   - Add request queuing

3. **Dimension mismatch**
   - Database expects 384-dim (all-MiniLM-L6-v2)
   - Verify model output dimensions

**Resolution:**
1. Ensure embedding model is available
2. Verify model output dimensions (384)
3. Implement retry logic for API calls
4. Monitor embedding generation metrics

---

### 5. Database Storage Issues

**Symptoms:**
- Disk space alerts
- "No space left on device" errors
- Slow write operations

**Diagnosis:**
```bash
# Check database size
kubectl exec -n default deployment/postgres -- \
  psql -U indexer -d indexer -c \
  "SELECT 
    pg_size_pretty(pg_total_relation_size('symbols')) as symbols_size,
    pg_size_pretty(pg_total_relation_size('documents')) as docs_size,
    pg_size_pretty(pg_total_relation_size('symbols_embedding_hnsw_idx')) as index_size;"

# Check table bloat
kubectl exec -n default deployment/postgres -- \
  psql -U indexer -d indexer -c \
  "SELECT 
    schemaname, tablename, 
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
    n_dead_tup, n_live_tup
   FROM pg_stat_user_tables 
   ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;"
```

**Common Causes:**

1. **Excessive symbol versions**
   - Old commits not cleaned up
   - Symbol history growing unbounded

2. **Table bloat from updates**
   - PostgreSQL MVCC leaves dead tuples
   - VACUUM not running frequently enough

3. **Large HNSW indexes**
   - Expected: ~1.5x embedding storage overhead
   - Can grow with high m parameter

**Resolution:**

1. **Run VACUUM to reclaim space:**
   ```sql
   VACUUM FULL symbols;
   VACUUM FULL documents;
   VACUUM FULL symbol_versions;
   ```

2. **Delete old symbol versions:**
   ```sql
   -- Delete symbols from deleted repositories
   DELETE FROM symbols WHERE commit_id IN (
     SELECT commit_id FROM deleted_repositories
   );
   
   -- Delete symbols older than 6 months
   DELETE FROM symbol_versions 
   WHERE created_at < NOW() - INTERVAL '6 months';
   ```

3. **Tune autovacuum:**
   ```sql
   ALTER SYSTEM SET autovacuum_vacuum_scale_factor = 0.1;
   ALTER SYSTEM SET autovacuum_analyze_scale_factor = 0.05;
   SELECT pg_reload_conf();
   ```

4. **Monitor storage metrics:**
   ```bash
   # Add Prometheus alerts for disk usage
   kubectl apply -f - <<EOF
   apiVersion: monitoring.coreos.com/v1
   kind: PrometheusRule
   metadata:
     name: indexer-storage-alerts
   spec:
     groups:
     - name: indexer.storage
       rules:
       - alert: IndexerDiskSpaceLow
         expr: kubelet_volume_stats_available_bytes{persistentvolumeclaim="postgres-pvc"} 
               / kubelet_volume_stats_capacity_bytes{persistentvolumeclaim="postgres-pvc"} < 0.15
         for: 5m
         labels:
           severity: warning
         annotations:
           summary: "Indexer PostgreSQL disk space low"
   EOF
   ```

---

## Maintenance Procedures

### Regular Maintenance (Weekly)

1. **Run VACUUM ANALYZE:**
   ```sql
   VACUUM ANALYZE symbols;
   VACUUM ANALYZE documents;
   VACUUM ANALYZE symbol_relationships;
   VACUUM ANALYZE symbol_versions;
   ```

2. **Check index health:**
   ```sql
   SELECT 
     schemaname, tablename, indexname, 
     idx_scan, idx_tup_read, idx_tup_fetch,
     pg_size_pretty(pg_relation_size(indexrelid)) as index_size
   FROM pg_stat_user_indexes
   WHERE schemaname = 'public'
   ORDER BY idx_scan DESC;
   ```

3. **Monitor query performance:**
   ```sql
   SELECT 
     query, calls, total_time, mean_time, 
     stddev_time, rows
   FROM pg_stat_statements
   WHERE query LIKE '%embedding%'
   ORDER BY mean_time DESC
   LIMIT 10;
   ```

### Quarterly Maintenance

1. **Reindex HNSW indexes:**
   ```sql
   REINDEX INDEX CONCURRENTLY symbols_embedding_hnsw_idx;
   REINDEX INDEX CONCURRENTLY documents_embedding_hnsw_idx;
   ```

2. **Review and clean old data:**
   ```sql
   -- Archive or delete symbols from archived repositories
   DELETE FROM symbols 
   WHERE path LIKE 'archived/%' 
     AND updated_at < NOW() - INTERVAL '1 year';
   ```

3. **Backup database:**
   ```bash
   kubectl exec -n default deployment/postgres -- \
     pg_dump -U indexer -d indexer -Fc > indexer_backup_$(date +%Y%m%d).dump
   ```

---

## Performance Optimization

### Query Optimization

1. **Use appropriate similarity thresholds:**
   ```rust
   // Too low = many irrelevant results, slow
   SearchParams {
       similarity_threshold: 0.7,  // Good default
       top_k: 20,                  // Reasonable limit
       ...
   }
   ```

2. **Add filters to narrow search space:**
   ```rust
   SearchParams {
       path_prefix: Some("src/"),     // Limit to specific directory
       kind_filter: Some(vec!["function", "class"]),  // Specific symbol types
       commit_id: Some("abc123"),     // Specific commit
       ...
   }
   ```

3. **Use batch operations for bulk indexing:**
   ```rust
   // Instead of:
   for symbol in symbols {
       storage.store_symbol(symbol).await?;
   }
   
   // Use:
   storage.store_symbols_batch(symbols).await?;
   ```

### PostgreSQL Tuning

For dedicated indexer database with 16GB RAM:

```sql
-- Memory settings
ALTER SYSTEM SET shared_buffers = '4GB';
ALTER SYSTEM SET effective_cache_size = '12GB';
ALTER SYSTEM SET work_mem = '256MB';
ALTER SYSTEM SET maintenance_work_mem = '1GB';

-- Query planner
ALTER SYSTEM SET random_page_cost = 1.1;  -- SSD
ALTER SYSTEM SET effective_io_concurrency = 200;

-- Autovacuum (for high update workloads)
ALTER SYSTEM SET autovacuum_max_workers = 4;
ALTER SYSTEM SET autovacuum_naptime = '10s';

-- Checkpoint tuning
ALTER SYSTEM SET checkpoint_timeout = '15min';
ALTER SYSTEM SET checkpoint_completion_target = 0.9;
ALTER SYSTEM SET wal_buffers = '16MB';

SELECT pg_reload_conf();
```

---

## Monitoring & Alerts

### Key Metrics

Monitor these Prometheus metrics:

1. **Search Performance:**
   - `indexer_search_duration_seconds` (P50, P95, P99)
   - `indexer_search_total` (request rate)
   - `indexer_search_errors_total` (error rate)

2. **Storage:**
   - `indexer_symbols_total` (symbol count)
   - `indexer_documents_total` (document count)
   - `indexer_storage_bytes` (total storage)
   - `indexer_index_bytes` (HNSW index size)

3. **Database:**
   - `pg_stat_user_tables_n_tup_ins` (insert rate)
   - `pg_stat_user_tables_n_dead_tup` (dead tuple count)
   - `pg_stat_database_conflicts` (lock conflicts)

### Recommended Alerts

```yaml
groups:
- name: indexer.performance
  rules:
  - alert: IndexerSearchSlow
    expr: histogram_quantile(0.95, rate(indexer_search_duration_seconds_bucket[5m])) > 1
    for: 10m
    annotations:
      summary: "Vector search P95 latency > 1s"
  
  - alert: IndexerHighErrorRate
    expr: rate(indexer_search_errors_total[5m]) / rate(indexer_search_total[5m]) > 0.05
    for: 5m
    annotations:
      summary: "Search error rate > 5%"

- name: indexer.storage
  rules:
  - alert: IndexerDeadTuplesHigh
    expr: pg_stat_user_tables_n_dead_tup{table="symbols"} > 100000
    for: 30m
    annotations:
      summary: "High dead tuple count, run VACUUM"
```

---

## Security Considerations

1. **Access Control:**
   - Limit gRPC API access via network policies
   - Use mTLS for service-to-service communication
   - Rotate PostgreSQL credentials regularly

2. **Data Protection:**
   - Enable encryption at rest for PostgreSQL
   - Redact sensitive code patterns before indexing
   - Implement row-level security for multi-tenant setups

3. **Audit Logging:**
   - Log all search operations with user context
   - Track symbol deletion events
   - Monitor for unusual query patterns

---

## Contact & Escalation

- **Primary:** Platform Team (#platform-team)
- **Secondary:** Database Team (#database-ops)
- **On-call:** PagerDuty integration for critical alerts

## References

- [Vector Search Implementation](../services/indexer/VECTOR_SEARCH_IMPLEMENTATION.md)
- [PostgreSQL + pgvector Documentation](https://github.com/pgvector/pgvector)
- [Tree-sitter Documentation](https://tree-sitter.github.io/tree-sitter/)
- [System Card](../compliance/system-card.md)
