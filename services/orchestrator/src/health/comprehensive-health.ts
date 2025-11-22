/**
 * Comprehensive Health Check Module
 *
 * Provides health status for:
 * - AI Providers
 * - Queue systems (Kafka/RabbitMQ)
 * - Database connections
 * - Cache systems
 * - External dependencies
 */

import type { Express } from 'express';
import { getProvider } from '../providers/ProviderRegistry.js';
import { checkProviderHealth, type ProviderHealthStatus } from '../providers/health.js';
import { KafkaAdapter } from '../queue/KafkaAdapter.js';
import { RabbitMQAdapter } from '../queue/RabbitMQAdapter.js';
import type { QueueAdapter } from '../queue/QueueAdapter.js';
import { appLogger as logger } from '../observability/logger.js';
import { getPostgresPool } from '../database/Postgres.js';
import { redis } from '../cache/index.js';
import { toError } from '../utils/errorUtils.js';

export interface QueueHealthStatus {
  transport: 'kafka' | 'rabbitmq';
  status: 'healthy' | 'degraded' | 'unhealthy';
  message?: string;
  details?: {
    connected: boolean;
    depth?: number;
    lag?: number;
    consumers?: number;
    error?: string;
  };
  lastCheck: string;
}

export interface DatabaseHealthStatus {
  type: 'postgres' | 'redis';
  status: 'healthy' | 'degraded' | 'unhealthy';
  message?: string;
  responseTimeMs?: number;
  details?: {
    connected: boolean;
    activeConnections?: number;
    maxConnections?: number;
    error?: string;
  };
  lastCheck: string;
}

export interface ComprehensiveHealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  uptime: number;
  providers: Record<string, ProviderHealthStatus>;
  queues: QueueHealthStatus[];
  databases: DatabaseHealthStatus[];
  summary: {
    providers: {
      total: number;
      healthy: number;
      degraded: number;
      unhealthy: number;
    };
    queues: {
      total: number;
      healthy: number;
      degraded: number;
      unhealthy: number;
    };
    databases: {
      total: number;
      healthy: number;
      degraded: number;
      unhealthy: number;
    };
  };
}

/**
 * Check queue health
 */
async function checkQueueHealth(
  queueAdapter: QueueAdapter | null,
  transport: 'kafka' | 'rabbitmq'
): Promise<QueueHealthStatus> {
  const startTime = Date.now();

  try {
    if (!queueAdapter) {
      return {
        transport,
        status: 'unconfigured' as any,
        message: `${transport} is not configured`,
        details: {
          connected: false,
        },
        lastCheck: new Date().toISOString(),
      };
    }

    // Check connection status
    const isConnected = await (queueAdapter as any).isConnected();

    if (!isConnected) {
      return {
        transport,
        status: 'unhealthy',
        message: `${transport} is not connected`,
        details: {
          connected: false,
          error: 'Connection lost',
        },
        lastCheck: new Date().toISOString(),
      };
    }

    // Get queue metrics
    let queueDepth = 0;
    let consumerLag = 0;
    let activeConsumers = 0;

    if (transport === 'kafka' && queueAdapter instanceof KafkaAdapter) {
      // Kafka-specific metrics
      const admin = (queueAdapter as any).admin;
      if (admin) {
        try {
          const metadata = await admin.fetchTopicMetadata({
            topics: ['plan.steps', 'plan.completions'],
          });

          // Get consumer group offsets
          const offsets = await admin.fetchOffsets({
            groupId: process.env.KAFKA_CONSUMER_GROUP || 'orchestrator-plan-runtime',
            topics: ['plan.steps'],
          });

          // Calculate lag
          for (const partition of offsets) {
            const highWatermark = partition.high;
            const currentOffset = partition.offset;
            if (highWatermark && currentOffset) {
              consumerLag += parseInt(highWatermark) - parseInt(currentOffset);
            }
          }

          // Get consumer group members
          const groups = await admin.describeGroups([
            process.env.KAFKA_CONSUMER_GROUP || 'orchestrator-plan-runtime',
          ]);
          activeConsumers = groups.groups[0]?.members?.length || 0;

        } catch (error) {
          logger.warn({ error }, 'Failed to fetch Kafka metrics');
        }
      }
    } else if (transport === 'rabbitmq' && queueAdapter instanceof RabbitMQAdapter) {
      // RabbitMQ-specific metrics
      const channel = (queueAdapter as any).channel;
      if (channel) {
        try {
          const queueInfo = await channel.checkQueue('plan.steps');
          queueDepth = queueInfo.messageCount || 0;
          activeConsumers = queueInfo.consumerCount || 0;
        } catch (error) {
          logger.warn({ error }, 'Failed to fetch RabbitMQ metrics');
        }
      }
    }

    // Determine health status based on metrics
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    let message = `${transport} is operational`;

    if (transport === 'kafka' && consumerLag > 1000) {
      status = 'degraded';
      message = `High consumer lag detected: ${consumerLag}`;
    } else if (transport === 'rabbitmq' && queueDepth > 1000) {
      status = 'degraded';
      message = `High queue depth: ${queueDepth}`;
    }

    if (activeConsumers === 0) {
      status = 'unhealthy';
      message = `No active consumers`;
    }

    return {
      transport,
      status,
      message,
      details: {
        connected: true,
        depth: queueDepth,
        lag: consumerLag,
        consumers: activeConsumers,
      },
      lastCheck: new Date().toISOString(),
    };

  } catch (error: unknown) {
    const err = toError(error);
    return {
      transport,
      status: 'unhealthy',
      message: `Health check failed: ${err.message}`,
      details: {
        connected: false,
        error: err.message,
      },
      lastCheck: new Date().toISOString(),
    };
  }
}

/**
 * Check database health
 */
async function checkDatabaseHealth(
  type: 'postgres' | 'redis'
): Promise<DatabaseHealthStatus> {
  const startTime = Date.now();

  try {
    if (type === 'postgres') {
      // PostgreSQL health check
      const pool = getPostgresPool();
      if (!pool) {
        throw new Error("Postgres pool not initialized");
      }
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
        const responseTimeMs = Date.now() - startTime;

        // Get connection pool stats
        const totalConnections = pool.totalCount;
        const idleConnections = pool.idleCount;
        const waitingConnections = pool.waitingCount;

        let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
        let message = 'PostgreSQL is operational';

        // Check for connection pool saturation
        if (waitingConnections > 0) {
          status = 'degraded';
          message = `Connection pool has ${waitingConnections} waiting requests`;
        }

        return {
          type: 'postgres',
          status,
          message,
          responseTimeMs,
          details: {
            connected: true,
            activeConnections: totalConnections - idleConnections,
            maxConnections: pool.options.max || 20,
          },
          lastCheck: new Date().toISOString(),
        };
      } finally {
        client.release();
      }
    } else if (type === 'redis') {
      // Redis health check
      const ping = await redis.ping();
      const responseTimeMs = Date.now() - startTime;

      if (ping === 'PONG') {
        // Get Redis info
        const info = await redis.info('clients');
        const connectedClients = parseInt(
          info.match(/connected_clients:(\d+)/)?.[1] || '0'
        );

        return {
          type: 'redis',
          status: 'healthy',
          message: 'Redis is operational',
          responseTimeMs,
          details: {
            connected: true,
            activeConnections: connectedClients,
          },
          lastCheck: new Date().toISOString(),
        };
      } else {
        return {
          type: 'redis',
          status: 'unhealthy',
          message: 'Redis ping failed',
          responseTimeMs,
          details: {
            connected: false,
            error: 'Ping response invalid',
          },
          lastCheck: new Date().toISOString(),
        };
      }
    }
  } catch (error: unknown) {
    const err = toError(error);
    return {
      type,
      status: 'unhealthy',
      message: `${type} connection failed`,
      responseTimeMs: Date.now() - startTime,
      details: {
        connected: false,
        error: err.message,
      },
      lastCheck: new Date().toISOString(),
    };
  }

  // Default return for TypeScript
  return {
    type,
    status: 'unhealthy',
    message: 'Unknown database type',
    details: {
      connected: false,
    },
    lastCheck: new Date().toISOString(),
  };
}

/**
 * Get comprehensive health status
 */
export async function getComprehensiveHealth(
  options: {
    includeProviders?: boolean;
    includeQueues?: boolean;
    includeDatabases?: boolean;
    skipActualRequests?: boolean;
  } = {}
): Promise<ComprehensiveHealthStatus> {
  const {
    includeProviders = true,
    includeQueues = true,
    includeDatabases = true,
    skipActualRequests = true,
  } = options;

  const startTime = Date.now();
  const health: ComprehensiveHealthStatus = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    uptime: process.uptime(),
    providers: {},
    queues: [],
    databases: [],
    summary: {
      providers: {
        total: 0,
        healthy: 0,
        degraded: 0,
        unhealthy: 0,
      },
      queues: {
        total: 0,
        healthy: 0,
        degraded: 0,
        unhealthy: 0,
      },
      databases: {
        total: 0,
        healthy: 0,
        degraded: 0,
        unhealthy: 0,
      },
    },
  };

  // Check providers
  if (includeProviders) {
    const providerNames = [
      'openai',
      'anthropic',
      'google',
      'azure-openai',
      'bedrock',
      'mistral',
      'openrouter',
      'ollama',
    ];

    for (const name of providerNames) {
      try {
        const provider = getProvider(name);
        if (provider) {
          const status = await checkProviderHealth(provider, {
            skipActualRequest: skipActualRequests,
          });
          health.providers[name] = status;
          health.summary.providers.total++;
          health.summary.providers[status.status as keyof typeof health.summary.providers]++;
        }
      } catch (error) {
        health.providers[name] = {
          provider: name,
          status: 'unconfigured',
          message: 'Provider not configured',
          lastCheck: new Date().toISOString(),
        };
        health.summary.providers.total++;
        health.summary.providers.unhealthy++;
      }
    }
  }

  // Check queues
  if (includeQueues) {
    const transport = process.env.QUEUE_TRANSPORT || 'rabbitmq';

    if (transport === 'kafka') {
      const kafkaHealth = await checkQueueHealth(
        (global as any).queueAdapter as KafkaAdapter,
        'kafka'
      );
      health.queues.push(kafkaHealth);
      health.summary.queues.total++;
      health.summary.queues[kafkaHealth.status as keyof typeof health.summary.queues]++;
    } else {
      const rabbitHealth = await checkQueueHealth(
        (global as any).queueAdapter as RabbitMQAdapter,
        'rabbitmq'
      );
      health.queues.push(rabbitHealth);
      health.summary.queues.total++;
      health.summary.queues[rabbitHealth.status as keyof typeof health.summary.queues]++;
    }
  }

  // Check databases
  if (includeDatabases) {
    const pgHealth = await checkDatabaseHealth('postgres');
    health.databases.push(pgHealth);
    health.summary.databases.total++;
    health.summary.databases[pgHealth.status as keyof typeof health.summary.databases]++;

    const redisHealth = await checkDatabaseHealth('redis');
    health.databases.push(redisHealth);
    health.summary.databases.total++;
    health.summary.databases[redisHealth.status as keyof typeof health.summary.databases]++;
  }

  // Determine overall health status
  const totalUnhealthy =
    health.summary.providers.unhealthy +
    health.summary.queues.unhealthy +
    health.summary.databases.unhealthy;

  const totalDegraded =
    health.summary.providers.degraded +
    health.summary.queues.degraded +
    health.summary.databases.degraded;

  if (totalUnhealthy > 0) {
    health.status = 'unhealthy';
  } else if (totalDegraded > 0) {
    health.status = 'degraded';
  }

  return health;
}

/**
 * Register comprehensive health endpoints
 */
export function registerComprehensiveHealthEndpoints(app: Express): void {
  // Comprehensive health check
  app.get('/health/comprehensive', async (req, res) => {
    try {
      const health = await getComprehensiveHealth({
        includeProviders: req.query.providers !== 'false',
        includeQueues: req.query.queues !== 'false',
        includeDatabases: req.query.databases !== 'false',
        skipActualRequests: req.query.detailed !== 'true',
      });

      const statusCode =
        health.status === 'healthy' ? 200 :
          health.status === 'degraded' ? 200 : // Still return 200 for degraded
            503;

      res.status(statusCode).json(health);
    } catch (error: unknown) {
      const err = toError(error);
      logger.error({ error: err }, 'Comprehensive health check failed');
      res.status(503).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: err.message,
      });
    }
  });

  // Queue-specific health check
  app.get('/health/queues', async (req, res) => {
    try {
      const health = await getComprehensiveHealth({
        includeProviders: false,
        includeQueues: true,
        includeDatabases: false,
      });

      res.status(health.status === 'unhealthy' ? 503 : 200).json({
        status: health.status,
        timestamp: health.timestamp,
        queues: health.queues,
        summary: health.summary.queues,
      });
    } catch (error: unknown) {
      const err = toError(error);
      logger.error({ error: err }, 'Queue health check failed');
      res.status(503).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: err.message,
      });
    }
  });

  // Database health check
  app.get('/health/databases', async (req, res) => {
    try {
      const health = await getComprehensiveHealth({
        includeProviders: false,
        includeQueues: false,
        includeDatabases: true,
      });

      res.status(health.status === 'unhealthy' ? 503 : 200).json({
        status: health.status,
        timestamp: health.timestamp,
        databases: health.databases,
        summary: health.summary.databases,
      });
    } catch (error: unknown) {
      const err = toError(error);
      logger.error({ error: err }, 'Database health check failed');
      res.status(503).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: err.message,
      });
    }
  });

  logger.info('Comprehensive health endpoints registered');
}
