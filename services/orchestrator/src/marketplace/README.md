# Marketplace Module

The Marketplace module provides a complete tool publishing, discovery, and management system for the OSS AI Agent Tool platform.

## Features

### Tool Publishing
- **Semantic Versioning**: Full semver support with prerelease and build metadata
- **Security Scanning**: Automated security analysis of tool packages
- **Publication Workflow**: Draft → Pending Review → Published states
- **Version Management**: Update, deprecate, and archive tools

### Discovery & Search
- **Full-Text Search**: Search tools by name and description
- **Capability Filtering**: Find tools by specific capabilities
- **Tag-based Discovery**: Browse by categories and tags
- **Rating System**: User reviews with 1-5 star ratings
- **Featured Tools**: Curated list of popular tools
- **Trending Tools**: Recently updated popular tools
- **Similar Tools**: AI-powered recommendations

### Security
- **Automated Scanning**: Pattern-based security analysis
- **Finding Categories**:
  - Hardcoded secrets/credentials
  - Suspicious API usage (eval, Function, etc.)
  - Network call analysis
  - File system access patterns
  - Dangerous function usage
- **Severity Levels**: Critical, High, Medium, Low, Info
- **Pass/Fail Gates**: Prevent publishing of insecure tools

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Marketplace API                          │
│  POST   /marketplace/tools          - Publish tool           │
│  GET    /marketplace/tools          - Search tools           │
│  GET    /marketplace/tools/:id      - Get tool details       │
│  PUT    /marketplace/tools/:id      - Update version         │
│  DELETE /marketplace/tools/:id      - Delete tool            │
│  POST   /marketplace/tools/:id/reviews - Submit review       │
│  GET    /marketplace/featured       - Featured tools         │
│  GET    /marketplace/trending       - Trending tools         │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                   MarketplaceService                         │
│  - Business logic and validation                            │
│  - Version comparison and management                        │
│  - Authorization checks                                     │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────┬──────────────────────────────────────┐
│  MarketplaceRepository │      SecurityScanner               │
│  - PostgreSQL storage  │  - Pattern matching                │
│  - Full-text search    │  - Static analysis                 │
│  - Reviews & ratings   │  - Finding classification          │
└──────────────────────┴──────────────────────────────────────┘
```

## Database Schema

### marketplace_tools
```sql
CREATE TABLE marketplace_tools (
  id TEXT PRIMARY KEY,
  manifest JSONB NOT NULL,
  publisher_tenant_id TEXT NOT NULL,
  publisher_user_id TEXT NOT NULL,
  publisher_name TEXT,
  publisher_email TEXT,
  status TEXT NOT NULL,
  package_url TEXT NOT NULL,
  published_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  downloads INTEGER NOT NULL DEFAULT 0,
  rating_average NUMERIC(3, 2),
  rating_count INTEGER NOT NULL DEFAULT 0,
  security_scan_status TEXT NOT NULL,
  security_scan_result JSONB,
  security_scan_at TIMESTAMPTZ
);
```

### marketplace_reviews
```sql
CREATE TABLE marketplace_reviews (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL REFERENCES marketplace_tools(id),
  reviewer_user_id TEXT NOT NULL,
  reviewer_name TEXT,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title TEXT,
  comment TEXT,
  helpful INTEGER NOT NULL DEFAULT 0,
  verified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tool_id, reviewer_user_id)
);
```

## Usage Examples

### Publishing a Tool

```typescript
import { getMarketplaceService } from './marketplace';

const service = getMarketplaceService();

const listing = await service.publishTool({
  manifest: {
    id: 'com.example.my-tool',
    name: 'My Awesome Tool',
    description: 'Does something amazing',
    version: { major: 1, minor: 0, patch: 0 },
    author: { name: 'John Doe', email: 'john@example.com' },
    license: 'MIT',
    capabilities: ['READ_FILES', 'WRITE_FILES'],
    tags: ['productivity', 'automation'],
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path'],
    },
  },
  packageUrl: 'https://cdn.example.com/my-tool-v1.0.0.tar.gz',
}, {
  tenantId: 'tenant-123',
  userId: 'user-456',
  name: 'John Doe',
  email: 'john@example.com',
});

console.log('Published:', listing.id, 'Status:', listing.status);
```

### Searching Tools

```typescript
const results = await service.searchTools({
  q: 'file management',
  capabilities: ['READ_FILES', 'WRITE_FILES'],
  tags: ['productivity'],
  minRating: 4.0,
  limit: 20,
  offset: 0,
  sortBy: 'downloads',
  sortOrder: 'desc',
});

console.log(`Found ${results.total} tools`);
results.items.forEach(tool => {
  console.log(`${tool.manifest.name} - ${tool.downloads} downloads`);
});
```

### Updating a Version

```typescript
await service.updateToolVersion({
  toolId: 'com.example.my-tool',
  version: { major: 1, minor: 1, patch: 0 },
  manifest: {
    description: 'Updated description with new features',
    changelog: '## v1.1.0\n- Added feature X\n- Fixed bug Y',
  },
  packageUrl: 'https://cdn.example.com/my-tool-v1.1.0.tar.gz',
}, {
  tenantId: 'tenant-123',
  userId: 'user-456',
});
```

### Submitting a Review

```typescript
const review = await service.submitReview({
  toolId: 'com.example.my-tool',
  rating: 5,
  title: 'Excellent tool!',
  comment: 'This tool saved me hours of work. Highly recommended!',
}, {
  userId: 'reviewer-789',
  name: 'Jane Smith',
});
```

## API Endpoints

### POST /marketplace/tools
Publish a new tool to the marketplace.

**Request Body:**
```json
{
  "manifest": {
    "id": "com.example.tool",
    "name": "Tool Name",
    "description": "Tool description (min 10 chars)",
    "version": { "major": 1, "minor": 0, "patch": 0 },
    "author": { "name": "Author Name", "email": "author@example.com" },
    "license": "MIT",
    "capabilities": ["READ_FILES"],
    "tags": ["category1", "category2"],
    "inputSchema": { "type": "object" }
  },
  "packageUrl": "https://cdn.example.com/tool.tar.gz",
  "skipSecurityScan": false
}
```

**Response:** `201 Created`
```json
{
  "tool": { /* ToolListing */ },
  "requestId": "req-123",
  "traceId": "trace-456"
}
```

### GET /marketplace/tools
Search for tools in the marketplace.

**Query Parameters:**
- `q`: Search query string
- `capabilities`: Capability filter (can be multiple)
- `tags`: Tag filter (can be multiple)
- `author`: Author name filter
- `minRating`: Minimum rating (0-5)
- `status`: Publication status filter
- `limit`: Results per page (1-100, default: 20)
- `offset`: Page offset (default: 0)
- `sortBy`: Sort field (downloads, rating, updated, created, relevance)
- `sortOrder`: Sort order (asc, desc)

**Response:** `200 OK`
```json
{
  "tools": [ /* ToolListing[] */ ],
  "total": 42,
  "limit": 20,
  "offset": 0,
  "requestId": "req-123",
  "traceId": "trace-456"
}
```

### GET /marketplace/tools/:toolId
Get details of a specific tool.

**Response:** `200 OK`
```json
{
  "tool": { /* ToolListing */ },
  "requestId": "req-123",
  "traceId": "trace-456"
}
```

### PUT /marketplace/tools/:toolId
Update a tool version (must be owner).

**Request Body:**
```json
{
  "version": { "major": 1, "minor": 1, "patch": 0 },
  "manifest": {
    "description": "Updated description",
    "changelog": "## v1.1.0\n- New features"
  },
  "packageUrl": "https://cdn.example.com/tool-v1.1.0.tar.gz"
}
```

### DELETE /marketplace/tools/:toolId
Delete a tool from the marketplace (must be owner).

**Response:** `204 No Content`

### POST /marketplace/tools/:toolId/reviews
Submit a review for a tool.

**Request Body:**
```json
{
  "rating": 5,
  "title": "Great tool!",
  "comment": "Works perfectly for my needs"
}
```

### GET /marketplace/tools/:toolId/reviews
Get reviews for a tool.

**Query Parameters:**
- `limit`: Reviews per page (default: 20)
- `offset`: Page offset (default: 0)

### GET /marketplace/featured
Get featured tools (most downloaded).

**Query Parameters:**
- `limit`: Number of tools (default: 10)

### GET /marketplace/trending
Get trending tools (recently popular).

**Query Parameters:**
- `limit`: Number of tools (default: 10)

### GET /marketplace/tools/:toolId/similar
Get similar tools based on capabilities and tags.

**Query Parameters:**
- `limit`: Number of similar tools (default: 5)

### GET /marketplace/my-tools
Get tools published by the authenticated user.

## Security Scanning

The security scanner performs static analysis on tool packages:

### Scan Categories

1. **Hardcoded Secrets**
   - API keys, passwords, tokens
   - Private keys
   - Credentials in code

2. **Suspicious APIs**
   - `eval()`, `Function()`
   - `child_process.exec()`
   - Dynamic code execution

3. **Network Calls**
   - Outbound HTTP/HTTPS requests
   - WebSocket connections
   - Unknown destinations

4. **File System Access**
   - File deletion operations
   - Write operations
   - Permission changes

5. **Dangerous Functions**
   - Code obfuscation
   - VM context manipulation
   - Unsafe deserialization

### Severity Levels

- **Critical**: Immediate security risk, blocks publication
- **High**: Serious issue requiring review
- **Medium**: Potential security concern
- **Low**: Best practice violation
- **Info**: Informational finding

## Authorization

All marketplace operations enforce policy-based authorization:

- `marketplace.publish`: Publish and update tools
- `marketplace.manage`: Delete and archive tools
- Tool owners can modify their own tools
- Admin role can approve pending tools

## Observability

The marketplace module provides comprehensive metrics:

```typescript
// Prometheus metrics
marketplace_tools_total{status="published"}
marketplace_downloads_total{tool_id="..."}
marketplace_reviews_total{rating="5"}
marketplace_search_queries_total
marketplace_security_scans_total{status="passed"}
```

Audit logging tracks all operations:
- Tool publications
- Version updates
- Reviews submitted
- Downloads recorded
- Security scan results

## Testing

Run the test suite:

```bash
npm test src/marketplace
```

Test coverage:
- Unit tests for service logic
- Integration tests for API routes
- Type validation tests
- Version comparison utilities

## Production Deployment

### Environment Variables

```bash
# Enable security scanning in production
NODE_ENV=production

# Auto-publish tools that pass scan (set to false for manual review)
MARKETPLACE_AUTO_PUBLISH=false

# Security scan timeout
MARKETPLACE_SCAN_TIMEOUT=60000
```

### Database Migration

Run initialization to create tables and indexes:

```typescript
import { initializeMarketplace } from './marketplace';
import { pool } from './config';

await initializeMarketplace(pool);
```

### Rate Limiting

Configure marketplace endpoints in rate limits:

```yaml
rateLimits:
  marketplace:
    publish: 10/hour
    search: 100/minute
    download: 1000/hour
```

## Future Enhancements

- [ ] Package integrity verification (checksums, signatures)
- [ ] Dependency vulnerability scanning
- [ ] Automated testing of tool functionality
- [ ] Machine learning-based recommendation engine
- [ ] Multi-language support for descriptions
- [ ] Tool analytics and usage statistics
- [ ] Premium/verified publisher badges
- [ ] Marketplace revenue sharing model
