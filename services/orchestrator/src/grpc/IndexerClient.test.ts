import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IndexerClient, SymbolKind } from './IndexerClient';
import pino from 'pino';

describe('IndexerClient', () => {
  let client: IndexerClient;
  const logger = pino({ level: 'silent' });

  beforeEach(() => {
    // Mock client - in real tests, you'd use a test gRPC server
    client = new IndexerClient({
      host: 'localhost',
      port: 9201,
      logger,
      maxRetries: 1,
      retryDelayMs: 100,
      timeoutMs: 5000,
    });
  });

  afterEach(() => {
    client.close();
  });

  it('should create client with correct configuration', () => {
    expect(client).toBeDefined();
  });

  it('should handle symbol conversion correctly', () => {
    const protoSymbol = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      path: 'src/main.ts',
      name: 'main',
      kind: SymbolKind.FUNCTION,
      content: 'function main() {}',
      embedding: [0.1, 0.2, 0.3],
      commit_id: 'abc123',
      start_line: 1,
      end_line: 3,
      metadata: { language: 'typescript' },
      created_at: { seconds: 1234567890, nanos: 0 },
      updated_at: { seconds: 1234567890, nanos: 0 },
    };

    // Access private method for testing
    const converted = (client as any).convertProtoSymbol(protoSymbol);

    expect(converted.id).toBe(protoSymbol.id);
    expect(converted.name).toBe('main');
    expect(converted.kind).toBe(SymbolKind.FUNCTION);
    expect(converted.embedding).toHaveLength(3);
  });

  it('should handle document conversion correctly', () => {
    const protoDocument = {
      id: '123e4567-e89b-12d3-a456-426614174001',
      path: 'README.md',
      content: '# Project',
      embedding: [0.4, 0.5, 0.6],
      commit_id: 'def456',
      metadata: { type: 'markdown' },
      created_at: { seconds: 1234567890, nanos: 0 },
      updated_at: { seconds: 1234567890, nanos: 0 },
    };

    const converted = (client as any).convertProtoDocument(protoDocument);

    expect(converted.id).toBe(protoDocument.id);
    expect(converted.path).toBe('README.md');
    expect(converted.embedding).toHaveLength(3);
  });

  it('should handle health status conversion', () => {
    expect((client as any).convertHealthStatus(1)).toBe('healthy');
    expect((client as any).convertHealthStatus(2)).toBe('degraded');
    expect((client as any).convertHealthStatus(3)).toBe('unhealthy');
    expect((client as any).convertHealthStatus(0)).toBe('unknown');
  });

  it('should set correct deadline', () => {
    const deadline = (client as any).getDeadline();
    const now = Date.now();
    const deadlineTime = deadline.getTime();

    expect(deadlineTime).toBeGreaterThan(now);
    expect(deadlineTime).toBeLessThanOrEqual(now + 10000);
  });
});
