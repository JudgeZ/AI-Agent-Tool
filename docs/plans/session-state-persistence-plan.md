# Session & State Persistence Implementation Plan

## Executive Summary

This plan addresses horizontal scaling limitations in the orchestrator service caused by in-memory data structures. The implementation follows existing patterns (particularly `PolicyCache.ts`) and the configuration system already established in the codebase.

**Components to Refactor:**
1. SessionStore (auth) - In-memory sessions
2. Queue Adapters - In-memory idempotency keys
3. AgentCommunication - In-memory MessageBus and SharedContextManager
4. DistributedLockService - Single-instance Redis lock (Redlock consideration)
5. PolicyCache - Missing cross-replica invalidation

---

## Phase 1: Session Management (`SessionStore.ts`)

### Current State
- Location: `services/orchestrator/src/auth/SessionStore.ts`
- Storage: In-memory `Map<string, SessionRecord>`
- Issues: Non-persistent, single-instance only, state loss on restart

### Implementation Steps

#### 1.1 Extract `ISessionStore` Interface

```typescript
// services/orchestrator/src/auth/ISessionStore.ts
export interface ISessionStore {
  createSession(input: CreateSessionInput, ttlSeconds: number, expiresAtMsOverride?: number): Promise<SessionRecord>;
  getSession(id: string): Promise<SessionRecord | undefined>;
  revokeSession(id: string): Promise<boolean>;
  clear(): Promise<void>;
  cleanupExpired(): Promise<void>;
  close?(): Promise<void>;
}
```

#### 1.2 Refactor `MemorySessionStore`

Rename existing `SessionStore` class to `MemorySessionStore` implementing `ISessionStore`. Make methods async to match the interface contract.

#### 1.3 Implement `RedisSessionStore`

```typescript
// services/orchestrator/src/auth/RedisSessionStore.ts
export class RedisSessionStore implements ISessionStore {
  private readonly keyPrefix = "session:";
  private readonly memory: MemorySessionStore; // L1 cache (optional)
  private client: RedisClient | null = null;
  // ... connection management following PolicyCache pattern
}
```

**Redis Key Structure:**
- Session data: `session:{sessionId}` → JSON-serialized `SessionRecord`
- TTL: Set via Redis `EX` option matching `expiresAt`
- Subject index (optional): `session:subject:{subject}` → Set of session IDs

**Features:**
- L1 memory cache (short TTL) for hot sessions
- Lazy connection initialization (following `PolicyCache` pattern)
- Graceful fallback to memory if Redis unavailable
- Automatic TTL enforcement via Redis expiration

#### 1.4 Add Configuration

Extend `AppConfig` in `loadConfig.ts`:

```typescript
export type SessionStoreProvider = "memory" | "redis";

export type SessionStoreRedisConfig = {
  url?: string;
  keyPrefix?: string;
};

export type SessionStoreConfig = {
  provider: SessionStoreProvider;
  redis?: SessionStoreRedisConfig;
};

// In AppConfig.auth:
auth: {
  // ... existing
  sessionStore: SessionStoreConfig;
};
```

**Environment Variables:**
- `SESSION_STORE_PROVIDER`: `memory` | `redis`
- `SESSION_STORE_REDIS_URL`: Redis connection string
- `SESSION_STORE_REDIS_KEY_PREFIX`: Key prefix (default: `session`)

#### 1.5 Factory Function

```typescript
// services/orchestrator/src/auth/createSessionStore.ts
export function createSessionStore(config: SessionStoreConfig): ISessionStore {
  if (config.provider === "redis" && config.redis?.url) {
    return new RedisSessionStore(config.redis);
  }
  return new MemorySessionStore();
}
```

### Testing Requirements
- Unit tests for `RedisSessionStore` with Redis mock
- Integration tests with real Redis (conditional on `REDIS_URL`)
- Verify TTL enforcement across replicas
- Test graceful degradation when Redis unavailable

---

## Phase 2: Queue Idempotency (`DistributedDedupeService`)

### Current State
- Location: `RabbitMQAdapter.ts:78`, `KafkaAdapter.ts` (similar)
- Storage: In-memory `Set<string>` (`inflightKeys`)
- Issues: Fails in distributed deployments, no TTL, state loss on restart

### Implementation Steps

#### 2.1 Create `IDedupeService` Interface

```typescript
// services/orchestrator/src/queue/IDedupeService.ts
export interface IDedupeService {
  /**
   * Attempt to claim an idempotency key.
   * Returns true if key was successfully claimed (not already in-flight).
   */
  claim(key: string, ttlMs: number): Promise<boolean>;

  /**
   * Release an idempotency key after processing complete.
   */
  release(key: string): Promise<void>;

  /**
   * Check if a key is currently claimed.
   */
  isClaimed(key: string): Promise<boolean>;

  close?(): Promise<void>;
}
```

#### 2.2 Implement `MemoryDedupeService`

```typescript
// services/orchestrator/src/queue/MemoryDedupeService.ts
export class MemoryDedupeService implements IDedupeService {
  private readonly keys = new Map<string, { expiresAt: number }>();
  // TTL-aware in-memory implementation for dev/test
}
```

#### 2.3 Implement `RedisDedupeService`

```typescript
// services/orchestrator/src/queue/RedisDedupeService.ts
export class RedisDedupeService implements IDedupeService {
  private readonly keyPrefix: string;
  private client: RedisClient | null = null;

  async claim(key: string, ttlMs: number): Promise<boolean> {
    const client = await this.getClient();
    // Use SET NX PX for atomic claim with TTL
    const result = await client.set(
      this.formatKey(key),
      "1",
      { NX: true, PX: ttlMs }
    );
    return result !== null;
  }

  async release(key: string): Promise<void> {
    const client = await this.getClient();
    await client.del(this.formatKey(key));
  }
}
```

**Redis Key Structure:**
- `dedupe:{queue}:{idempotencyKey}` → `"1"` with TTL

#### 2.4 Inject into Queue Adapters

Modify `RabbitMQAdapter` and `KafkaAdapter` constructors:

```typescript
type RabbitMQAdapterOptions = {
  // ... existing
  dedupeService?: IDedupeService;
};

// In constructor:
this.dedupe = options.dedupeService ?? new MemoryDedupeService();
```

Replace `this.inflightKeys.has(key)` with `await this.dedupe.isClaimed(key)`.

#### 2.5 Add Configuration

```typescript
export type DedupeServiceProvider = "memory" | "redis";

export type DedupeServiceConfig = {
  provider: DedupeServiceProvider;
  redis?: {
    url?: string;
    keyPrefix?: string;
    defaultTtlMs?: number;
  };
};
```

**Environment Variables:**
- `DEDUPE_SERVICE_PROVIDER`: `memory` | `redis`
- `DEDUPE_SERVICE_REDIS_URL`: Redis connection string
- `DEDUPE_DEFAULT_TTL_MS`: Default TTL (e.g., 300000 = 5 min)

### Testing Requirements
- Unit tests for both implementations
- Concurrent claim tests (verify atomicity)
- TTL expiration tests
- Integration test with queue adapters

---

## Phase 3: Agent Communication (`AgentCommunication.ts`)

### Current State
- Location: `services/orchestrator/src/agents/AgentCommunication.ts`
- Storage: In-memory `Map` for queues, handlers, context
- Issues: Single-instance only, no inter-replica messaging, state loss on restart

### Implementation Steps

#### 3.1 Extract `IMessageBus` Interface

```typescript
// services/orchestrator/src/agents/IMessageBus.ts
export interface IMessageBus {
  registerAgent(agentId: string): Promise<void>;
  unregisterAgent(agentId: string): Promise<void>;
  registerHandler(agentId: string, type: MessageType, handler: MessageHandler): void;
  send(message: Omit<Message, "id" | "timestamp">): Promise<string>;
  request(from: string, to: string, payload: MessagePayload, timeout?: number): Promise<unknown>;
  getMetrics(): MessageBusMetrics;
  getQueueSize(agentId: string): number;
  getRegisteredAgents(): string[];
  shutdown(): Promise<void>;

  // Event subscription
  on(event: string, listener: (...args: unknown[]) => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this;
}
```

#### 3.2 Refactor Existing as `MemoryMessageBus`

Rename `MessageBus` → `MemoryMessageBus`, implement `IMessageBus`.

#### 3.3 Implement `RedisMessageBus`

```typescript
// services/orchestrator/src/agents/RedisMessageBus.ts
export class RedisMessageBus extends EventEmitter implements IMessageBus {
  private subscriber: RedisClient;
  private publisher: RedisClient;
  private readonly channelPrefix = "msgbus:";

  // Use Redis Pub/Sub for cross-replica messaging
  // Messages published to channel: msgbus:agent:{agentId}
  // Broadcasts published to channel: msgbus:broadcast
}
```

**Redis Channels:**
- Agent messages: `msgbus:agent:{agentId}`
- Broadcasts: `msgbus:broadcast`
- Request-response correlation: Local + Redis hash for pending requests

**Architecture Notes:**
- Each orchestrator instance subscribes to channels for locally-registered agents
- Messages are published to Redis, received by the instance hosting the target agent
- Handlers remain local (not serializable), only message routing is distributed

#### 3.4 Extract `ISharedContext` Interface

```typescript
// services/orchestrator/src/agents/ISharedContext.ts
export interface ISharedContext {
  set(key: string, value: unknown, ownerId: string, scope?: ContextScope, ttl?: number): Promise<void>;
  get(key: string, requesterId: string): Promise<unknown | undefined>;
  delete(key: string, requesterId: string): Promise<boolean>;
  share(key: string, ownerId: string, agentIds: string[]): Promise<void>;
  query(options: ContextQueryOptions, requesterId: string): Promise<ContextEntry[]>;
  getEntryCount(): Promise<number>;
  getKeys(scope?: ContextScope): Promise<string[]>;
  shutdown(): Promise<void>;
}
```

#### 3.5 Implement `RedisSharedContext`

```typescript
// services/orchestrator/src/agents/RedisSharedContext.ts
export class RedisSharedContext implements ISharedContext {
  private readonly memory: MemorySharedContext; // L1 cache
  private readonly keyPrefix = "context:";

  // Redis key structure:
  // context:entry:{key} → JSON { value, scope, ownerId, ... }
  // context:acl:{key} → Set of allowed agent IDs
}
```

**Redis Key Structure:**
- Entry data: `context:entry:{key}` → JSON-serialized `ContextEntry`
- Access control: `context:acl:{key}` → Redis Set of agent IDs
- Owner index: `context:owner:{ownerId}` → Set of owned keys

#### 3.6 Add Configuration

```typescript
export type AgentCommunicationProvider = "memory" | "redis";

export type AgentCommunicationConfig = {
  messageBus: {
    provider: AgentCommunicationProvider;
    redis?: { url?: string; channelPrefix?: string };
  };
  sharedContext: {
    provider: AgentCommunicationProvider;
    redis?: { url?: string; keyPrefix?: string };
  };
};
```

### Testing Requirements
- Unit tests with Redis mock
- Multi-instance simulation tests
- Message delivery across instances
- Context sharing and access control
- Pub/Sub reliability under load

---

## Phase 4: Distributed Locking (`DistributedLockService.ts`)

### Current State
- Location: `services/orchestrator/src/services/DistributedLockService.ts`
- Implementation: Single Redis instance, `SET NX PX` + Lua release
- Issues: Not fault-tolerant against Redis failover

### Analysis

The current implementation is appropriate for most deployments:
- Uses `SET NX PX` for atomic lock acquisition
- Uses Lua script for safe token-based release
- Implements retry with configurable attempts and delay

**Redlock Consideration:**

Redlock is needed only when:
1. Running Redis in a multi-master or cluster configuration
2. Requiring lock correctness during Redis failover
3. High-stakes operations where split-brain could cause data corruption

### Implementation Steps

#### 4.1 Document Limitations

Add clear documentation to the existing service:

```typescript
/**
 * DistributedLockService provides distributed locking via Redis.
 *
 * LIMITATIONS:
 * - Assumes single Redis instance or Redis Sentinel with automatic failover
 * - NOT suitable for Redis Cluster in multi-master mode without Redlock
 * - Lock correctness depends on Redis availability
 *
 * For multi-master Redis deployments requiring strong consistency,
 * consider implementing Redlock or using a library like `redlock`.
 */
```

#### 4.2 Optional Redlock Implementation

If required, add a `RedlockDistributedLockService`:

```typescript
// services/orchestrator/src/services/RedlockDistributedLockService.ts
import Redlock from "redlock";

export class RedlockDistributedLockService {
  private readonly redlock: Redlock;

  constructor(redisClients: RedisClient[]) {
    this.redlock = new Redlock(redisClients, {
      driftFactor: 0.01,
      retryCount: 3,
      retryDelay: 200,
      retryJitter: 200,
    });
  }

  async acquireLock(resource: string, ttlMs: number): Promise<Lock> {
    return this.redlock.acquire([`lock:${resource}`], ttlMs);
  }
}
```

#### 4.3 Configuration Extension

```typescript
export type LockServiceProvider = "single" | "redlock";

export type LockServiceConfig = {
  provider: LockServiceProvider;
  redis?: {
    urls: string[]; // Multiple URLs for Redlock
  };
};
```

### Recommendation

**Keep existing implementation** for most deployments. Add Redlock only if:
- Customer requires multi-master Redis
- Explicit request for Redlock in configuration

Document the trade-offs in ADR format.

---

## Phase 5: Policy Cache Invalidation (`PolicyCache.ts`)

### Current State
- Location: `services/orchestrator/src/policy/PolicyCache.ts`
- Implementation: L1 (Memory) + L2 (Redis) caching
- Issue: No cross-replica invalidation; stale L1 data until TTL expires

### Implementation Steps

#### 5.1 Add Redis Pub/Sub Invalidation

```typescript
// Extend RedisPolicyDecisionCache
export class RedisPolicyDecisionCache implements PolicyDecisionCache {
  private subscriber: RedisClient | null = null;
  private readonly invalidationChannel = "policy:cache:invalidate";

  private async setupSubscription(): Promise<void> {
    const subscriber = this.subscriber = createClient({ url: this.redisUrl });
    await subscriber.connect();
    await subscriber.subscribe(this.invalidationChannel, (key: string) => {
      // Invalidate local L1 cache entry
      this.memory.invalidate(key);
      logger.debug({ key, event: "policy.cache.invalidated" }, "L1 cache invalidated via pub/sub");
    });
  }

  async set(key: string, decision: PolicyDecision): Promise<void> {
    await this.memory.set(key, decision);
    const client = await this.getClient();
    if (!client) return;

    await client.set(this.formatKey(key), JSON.stringify(decision), { EX: this.ttlSeconds });

    // Broadcast invalidation to other replicas
    await client.publish(this.invalidationChannel, key);
  }
}
```

#### 5.2 Add `invalidate()` Method to Memory Cache

```typescript
class MemoryPolicyDecisionCache {
  invalidate(key: string): void {
    this.entries.delete(key);
  }
}
```

#### 5.3 Handle Subscription Lifecycle

- Setup subscription on first `get()` or `set()` call
- Clean up subscription in `close()`
- Handle reconnection on Redis disconnect

### Testing Requirements
- Multi-instance invalidation test
- Verify L1 invalidation timing
- Test reconnection behavior
- Load test with high invalidation rate

---

## Configuration Summary

### New Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SESSION_STORE_PROVIDER` | `memory` | Session store backend |
| `SESSION_STORE_REDIS_URL` | - | Redis URL for sessions |
| `DEDUPE_SERVICE_PROVIDER` | `memory` | Deduplication backend |
| `DEDUPE_SERVICE_REDIS_URL` | - | Redis URL for dedupe |
| `DEDUPE_DEFAULT_TTL_MS` | `300000` | Default dedupe TTL |
| `MESSAGE_BUS_PROVIDER` | `memory` | Message bus backend |
| `MESSAGE_BUS_REDIS_URL` | - | Redis URL for messaging |
| `SHARED_CONTEXT_PROVIDER` | `memory` | Shared context backend |
| `SHARED_CONTEXT_REDIS_URL` | - | Redis URL for context |
| `LOCK_SERVICE_PROVIDER` | `single` | Lock service type |

### Production Configuration Example

```yaml
# config.yaml
auth:
  sessionStore:
    provider: redis
    redis:
      url: ${SESSION_STORE_REDIS_URL}
      keyPrefix: "session"

messaging:
  deduplication:
    provider: redis
    redis:
      url: ${REDIS_URL}
      keyPrefix: "dedupe"
      defaultTtlMs: 300000

agents:
  messageBus:
    provider: redis
    redis:
      url: ${REDIS_URL}
      channelPrefix: "msgbus"
  sharedContext:
    provider: redis
    redis:
      url: ${REDIS_URL}
      keyPrefix: "context"

policy:
  cache:
    enabled: true
    provider: redis
    redis:
      url: ${REDIS_URL}
      keyPrefix: "policy:decision"
```

---

## Implementation Order

**Recommended sequence based on dependencies and risk:**

1. **Phase 2: Queue Idempotency** - Lowest risk, isolated change
2. **Phase 1: Session Management** - High value, follows established pattern
3. **Phase 5: Policy Cache Invalidation** - Small scope, additive change
4. **Phase 3: Agent Communication** - Largest scope, most complex
5. **Phase 4: Distributed Locking** - Documentation + optional Redlock

---

## Risk Assessment

| Phase | Risk Level | Mitigation |
|-------|------------|------------|
| Session Store | Medium | L1 cache fallback, graceful degradation |
| Queue Dedupe | Low | Memory fallback, TTL prevents leaks |
| Agent Communication | High | Extensive testing, feature flag, gradual rollout |
| Lock Service | Low | Document limitations, optional upgrade path |
| Policy Cache | Low | Additive change, existing L1/L2 pattern |

---

## Security Considerations

Per CLAUDE.md guidelines:

1. **No secrets in Redis keys** - Use opaque IDs, not user data
2. **Session security** - Regenerate session ID on auth state changes
3. **Audit logging** - Log session create/revoke, lock acquire/release
4. **Input validation** - Validate all keys/values before Redis operations
5. **Connection security** - Support TLS for Redis connections
6. **Rate limiting** - Consider Redis operation rate limits

---

## Testing Strategy

### Unit Tests
- Mock Redis client for all Redis-backed implementations
- Test error handling and fallback paths
- Test TTL enforcement

### Integration Tests
- Real Redis instance (conditional on `CI_REDIS_URL`)
- Multi-instance scenarios with docker-compose
- Failover and reconnection tests

### Load Tests
- Session store under concurrent load
- Message bus throughput
- Context operations per second
- Lock contention scenarios

---

## Monitoring & Observability

Add metrics for:
- Session store hit/miss ratio (L1 vs L2)
- Dedupe claim/release counts
- Message bus delivery latency
- Context operation latency
- Lock acquisition time and contention rate
- Redis connection pool utilization

---

## Rollback Plan

Each phase can be rolled back by:
1. Setting provider config back to `memory`
2. Redeploying orchestrator instances
3. No data migration needed (Redis data can be cleared)

For Phase 3 (Agent Communication), additional consideration:
- In-flight messages may be lost during rollback
- Schedule rollback during low-traffic period
