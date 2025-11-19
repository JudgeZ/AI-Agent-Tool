/* eslint-disable @typescript-eslint/no-explicit-any */
// justified: SQL query results have dynamic structure determined at runtime
// Type safety would require query builders like Prisma or compile-time SQL analysis
// Database drivers return untyped row objects that vary by query

import {
  McpTool,
  ToolMetadata,
  ToolCapability,
  ToolContext,
  ToolResult,
} from "../McpTool";
import { SandboxType } from "../../sandbox";
import { z } from "zod";
import { Pool } from "pg"; // PostgreSQL
import * as mysql from "mysql2/promise"; // MySQL
import { MongoClient, Db } from "mongodb";
import * as sqlite3 from "sqlite3";
import { promisify } from "util";
import { Logger } from "pino";

// ============================================================================
// Input/Output Schemas
// ============================================================================

const ConnectionInputSchema = z.object({
  type: z.enum(["postgres", "mysql", "mongodb", "sqlite"]),
  host: z.string().optional(),
  port: z.number().optional(),
  database: z.string(),
  username: z.string().optional(),
  password: z.string().optional(),
  connectionString: z.string().optional(), // Alternative to individual params
  ssl: z.boolean().default(false),
  poolSize: z.number().min(1).max(50).default(10),
});

const QueryInputSchema = z.object({
  query: z.string(),
  params: z
    .array(z.union([z.string(), z.number(), z.boolean(), z.null(), z.date()]))
    .optional(),
  timeout: z.number().min(100).max(60000).default(30000),
  maxRows: z.number().min(1).max(10000).default(1000),
});

const TransactionInputSchema = z.object({
  queries: z.array(
    z.object({
      query: z.string(),
      params: z
        .array(
          z.union([z.string(), z.number(), z.boolean(), z.null(), z.date()]),
        )
        .optional(),
    }),
  ),
  isolationLevel: z
    .enum([
      "READ UNCOMMITTED",
      "READ COMMITTED",
      "REPEATABLE READ",
      "SERIALIZABLE",
    ])
    .optional(),
});

const SchemaInputSchema = z.object({
  table: z.string().optional(), // Specific table or all tables
});

const BackupInputSchema = z.object({
  tables: z.array(z.string()).optional(), // Specific tables or all
  format: z.enum(["sql", "json"]).default("sql"),
  compress: z.boolean().default(false),
});

export type ConnectionInput = z.infer<typeof ConnectionInputSchema>;
export type QueryInput = z.infer<typeof QueryInputSchema>;
export type TransactionInput = z.infer<typeof TransactionInputSchema>;
export type SchemaInput = z.infer<typeof SchemaInputSchema>;
export type BackupInput = z.infer<typeof BackupInputSchema>;

export interface QueryOutput {
  rows: any[];
  rowCount: number;
  fields?: string[];
  duration: number;
}

export interface TransactionOutput {
  success: boolean;
  queriesExecuted: number;
  totalRowsAffected: number;
  duration: number;
}

export interface SchemaOutput {
  tables: Array<{
    name: string;
    columns: Array<{
      name: string;
      type: string;
      nullable: boolean;
      default?: any;
      primaryKey: boolean;
    }>;
    indexes: Array<{
      name: string;
      columns: string[];
      unique: boolean;
    }>;
  }>;
}

export interface BackupOutput {
  success: boolean;
  size: number; // Bytes
  tables: string[];
  data: string; // SQL or JSON dump
}

// ============================================================================
// Database Connection Interface
// ============================================================================

interface DatabaseConnection {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  query(query: string, params?: any[]): Promise<QueryOutput>;
  transaction(
    queries: Array<{ query: string; params?: any[] }>,
  ): Promise<TransactionOutput>;
  getSchema(table?: string): Promise<SchemaOutput>;
  isConnected(): boolean;
}

// ============================================================================
// PostgreSQL Connection
// ============================================================================

class PostgresConnection implements DatabaseConnection {
  private pool: Pool | null = null;
  private config: ConnectionInput;

  constructor(config: ConnectionInput) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.pool = new Pool({
      host: this.config.host,
      port: this.config.port || 5432,
      database: this.config.database,
      user: this.config.username,
      password: this.config.password,
      max: this.config.poolSize,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : false,
    });

    // Test connection
    await this.pool.query("SELECT 1");
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async query(query: string, params?: any[]): Promise<QueryOutput> {
    if (!this.pool) throw new Error("Not connected");

    const startTime = Date.now();
    const result = await this.pool.query(query, params);
    const duration = Date.now() - startTime;

    return {
      rows: result.rows,
      rowCount: result.rowCount || 0,
      fields: result.fields?.map((f) => f.name),
      duration,
    };
  }

  async transaction(
    queries: Array<{ query: string; params?: any[] }>,
  ): Promise<TransactionOutput> {
    if (!this.pool) throw new Error("Not connected");

    const client = await this.pool.connect();
    const startTime = Date.now();

    try {
      await client.query("BEGIN");

      let totalRowsAffected = 0;
      for (const { query, params } of queries) {
        const result = await client.query(query, params);
        totalRowsAffected += result.rowCount || 0;
      }

      await client.query("COMMIT");

      return {
        success: true,
        queriesExecuted: queries.length,
        totalRowsAffected,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getSchema(table?: string): Promise<SchemaOutput> {
    if (!this.pool) throw new Error("Not connected");

    const tablesQuery = table
      ? `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`
      : `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;

    const tablesResult = await this.pool.query(
      tablesQuery,
      table ? [table] : [],
    );
    const tables = [];

    for (const row of tablesResult.rows) {
      const tableName = row.table_name;

      // Get columns
      const columnsResult = await this.pool.query(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position`,
        [tableName],
      );

      // Get primary keys
      const pkResult = await this.pool.query(
        `SELECT a.attname
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = $1::regclass AND i.indisprimary`,
        [tableName],
      );

      const primaryKeys = new Set(pkResult.rows.map((r) => r.attname));

      const columns = columnsResult.rows.map((col) => ({
        name: col.column_name,
        type: col.data_type,
        nullable: col.is_nullable === "YES",
        default: col.column_default,
        primaryKey: primaryKeys.has(col.column_name),
      }));

      // Get indexes
      const indexesResult = await this.pool.query(
        `SELECT i.relname as index_name, a.attname as column_name, ix.indisunique
         FROM pg_class t
         JOIN pg_index ix ON t.oid = ix.indrelid
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
         WHERE t.relname = $1`,
        [tableName],
      );

      const indexMap = new Map<
        string,
        { columns: string[]; unique: boolean }
      >();
      for (const idx of indexesResult.rows) {
        if (!indexMap.has(idx.index_name)) {
          indexMap.set(idx.index_name, {
            columns: [],
            unique: idx.indisunique,
          });
        }
        indexMap.get(idx.index_name)!.columns.push(idx.column_name);
      }

      const indexes = Array.from(indexMap.entries()).map(([name, data]) => ({
        name,
        columns: data.columns,
        unique: data.unique,
      }));

      tables.push({ name: tableName, columns, indexes });
    }

    return { tables };
  }

  isConnected(): boolean {
    return this.pool !== null;
  }
}

// ============================================================================
// MySQL Connection
// ============================================================================

class MySQLConnection implements DatabaseConnection {
  private pool: mysql.Pool | null = null;
  private config: ConnectionInput;

  constructor(config: ConnectionInput) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.pool = mysql.createPool({
      host: this.config.host,
      port: this.config.port || 3306,
      database: this.config.database,
      user: this.config.username,
      password: this.config.password,
      connectionLimit: this.config.poolSize,
      ssl: this.config.ssl ? {} : undefined,
    });

    // Test connection
    await this.pool.query("SELECT 1");
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async query(query: string, params?: any[]): Promise<QueryOutput> {
    if (!this.pool) throw new Error("Not connected");

    const startTime = Date.now();
    const [rows, fields] = await this.pool.query(query, params);
    const duration = Date.now() - startTime;

    return {
      rows: Array.isArray(rows) ? rows : [],
      rowCount: Array.isArray(rows) ? rows.length : 0,
      fields: Array.isArray(fields)
        ? fields.map((f: any) => f.name)
        : undefined,
      duration,
    };
  }

  async transaction(
    queries: Array<{ query: string; params?: any[] }>,
  ): Promise<TransactionOutput> {
    if (!this.pool) throw new Error("Not connected");

    const connection = await this.pool.getConnection();
    const startTime = Date.now();

    try {
      await connection.beginTransaction();

      let totalRowsAffected = 0;
      for (const { query, params } of queries) {
        const [result] = await connection.query(query, params);
        totalRowsAffected += (result as any).affectedRows || 0;
      }

      await connection.commit();

      return {
        success: true,
        queriesExecuted: queries.length,
        totalRowsAffected,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async getSchema(table?: string): Promise<SchemaOutput> {
    if (!this.pool) throw new Error("Not connected");

    const tablesQuery = table
      ? `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`
      : `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`;

    const [tablesResult] = await this.pool.query(
      tablesQuery,
      table ? [this.config.database, table] : [this.config.database],
    );
    const tables = [];

    for (const row of tablesResult as any[]) {
      const tableName = row.TABLE_NAME;

      // Get columns
      const [columnsResult] = await this.pool.query(
        `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [this.config.database, tableName],
      );

      const columns = (columnsResult as any[]).map((col) => ({
        name: col.COLUMN_NAME,
        type: col.DATA_TYPE,
        nullable: col.IS_NULLABLE === "YES",
        default: col.COLUMN_DEFAULT,
        primaryKey: col.COLUMN_KEY === "PRI",
      }));

      // Get indexes
      const [indexesResult] = await this.pool.query(
        `SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [this.config.database, tableName],
      );

      const indexMap = new Map<
        string,
        { columns: string[]; unique: boolean }
      >();
      for (const idx of indexesResult as any[]) {
        if (!indexMap.has(idx.INDEX_NAME)) {
          indexMap.set(idx.INDEX_NAME, {
            columns: [],
            unique: idx.NON_UNIQUE === 0,
          });
        }
        indexMap.get(idx.INDEX_NAME)!.columns.push(idx.COLUMN_NAME);
      }

      const indexes = Array.from(indexMap.entries()).map(([name, data]) => ({
        name,
        columns: data.columns,
        unique: data.unique,
      }));

      tables.push({ name: tableName, columns, indexes });
    }

    return { tables };
  }

  isConnected(): boolean {
    return this.pool !== null;
  }
}

// ============================================================================
// MongoDB Connection
// ============================================================================

class MongoDBConnection implements DatabaseConnection {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private config: ConnectionInput;

  constructor(config: ConnectionInput) {
    this.config = config;
  }

  async connect(): Promise<void> {
    const uri =
      this.config.connectionString ||
      `mongodb://${this.config.username}:${this.config.password}@${this.config.host}:${this.config.port || 27017}`;

    this.client = new MongoClient(uri, {
      maxPoolSize: this.config.poolSize,
      ssl: this.config.ssl,
    });

    await this.client.connect();
    this.db = this.client.db(this.config.database);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
  }

  async query(query: string, params?: any[]): Promise<QueryOutput> {
    if (!this.db) throw new Error("Not connected");

    const startTime = Date.now();

    // Parse MongoDB query (expect JSON format)
    const { collection, operation, filter, update, options } =
      JSON.parse(query);

    const coll = this.db.collection(collection);
    let rows: any[] = [];

    switch (operation) {
      case "find":
        rows = await coll.find(filter || {}, options).toArray();
        break;
      case "findOne": {
        const doc = await coll.findOne(filter || {}, options);
        rows = doc ? [doc] : [];
        break;
      }
      case "insertOne": {
        const insertResult = await coll.insertOne(filter);
        rows = [{ insertedId: insertResult.insertedId }];
        break;
      }
      case "updateOne":
      case "updateMany": {
        const updateResult = await (coll as any)[operation](
          filter,
          update,
          options,
        );
        rows = [{ modifiedCount: updateResult.modifiedCount }];
        break;
      }
      case "deleteOne":
      case "deleteMany": {
        const deleteResult = await (coll as any)[operation](filter, options);
        rows = [{ deletedCount: deleteResult.deletedCount }];
        break;
      }
      default:
        throw new Error(`Unsupported MongoDB operation: ${operation}`);
    }

    return {
      rows,
      rowCount: rows.length,
      duration: Date.now() - startTime,
    };
  }

  async transaction(
    queries: Array<{ query: string; params?: any[] }>,
  ): Promise<TransactionOutput> {
    if (!this.client || !this.db) throw new Error("Not connected");

    const session = this.client.startSession();
    const startTime = Date.now();

    try {
      session.startTransaction();

      let totalRowsAffected = 0;
      for (const { query } of queries) {
        const result = await this.query(query);
        totalRowsAffected += result.rowCount;
      }

      await session.commitTransaction();

      return {
        success: true,
        queriesExecuted: queries.length,
        totalRowsAffected,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async getSchema(table?: string): Promise<SchemaOutput> {
    if (!this.db) throw new Error("Not connected");

    const collections = table
      ? [table]
      : (await this.db.listCollections().toArray()).map((c) => c.name);
    const tables = [];

    for (const collectionName of collections) {
      const collection = this.db.collection(collectionName);

      // Sample documents to infer schema
      const sampleDocs = await collection.find({}).limit(100).toArray();

      const fieldTypes = new Map<string, Set<string>>();
      for (const doc of sampleDocs) {
        for (const [key, value] of Object.entries(doc)) {
          if (!fieldTypes.has(key)) {
            fieldTypes.set(key, new Set());
          }
          fieldTypes.get(key)!.add(typeof value);
        }
      }

      const columns = Array.from(fieldTypes.entries()).map(([name, types]) => ({
        name,
        type: Array.from(types).join(" | "),
        nullable: true,
        primaryKey: name === "_id",
      }));

      // Get indexes
      const indexesResult = await collection.indexes();
      const indexes = indexesResult.map((idx: any) => ({
        name: idx.name,
        columns: Object.keys(idx.key),
        unique: idx.unique || false,
      }));

      tables.push({ name: collectionName, columns, indexes });
    }

    return { tables };
  }

  isConnected(): boolean {
    return this.client !== null && this.db !== null;
  }
}

// ============================================================================
// SQLite Connection
// ============================================================================

class SQLiteConnection implements DatabaseConnection {
  private db: sqlite3.Database | null = null;
  private config: ConnectionInput;

  constructor(config: ConnectionInput) {
    this.config = config;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.config.database, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      await promisify(this.db.close.bind(this.db))();
      this.db = null;
    }
  }

  async query(query: string, params?: any[]): Promise<QueryOutput> {
    if (!this.db) throw new Error("Not connected");

    const startTime = Date.now();
    const all = promisify(this.db.all.bind(this.db)) as (
      sql: string,
      params: any[],
    ) => Promise<any[]>;

    const rows = await all(query, params || []);
    const duration = Date.now() - startTime;

    return {
      rows: rows || [],
      rowCount: rows?.length || 0,
      fields: rows && rows.length > 0 ? Object.keys(rows[0]) : [],
      duration,
    };
  }

  async transaction(
    queries: Array<{ query: string; params?: any[] }>,
  ): Promise<TransactionOutput> {
    if (!this.db) throw new Error("Not connected");

    const startTime = Date.now();
    const run = promisify(this.db.run.bind(this.db)) as (
      sql: string,
      params?: any[],
    ) => Promise<any>;

    await run("BEGIN TRANSACTION");

    try {
      let totalRowsAffected = 0;
      for (const { query, params } of queries) {
        const result: any = await run(query, params || []);
        totalRowsAffected += result.changes || 0;
      }

      await run("COMMIT");

      return {
        success: true,
        queriesExecuted: queries.length,
        totalRowsAffected,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      await run("ROLLBACK");
      throw error;
    }
  }

  async getSchema(table?: string): Promise<SchemaOutput> {
    if (!this.db) throw new Error("Not connected");

    const all = promisify(this.db.all.bind(this.db)) as (
      sql: string,
      params?: any[],
    ) => Promise<any[]>;

    const tablesQuery = table
      ? `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
      : `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`;

    const tablesResult = await all(tablesQuery, table ? [table] : []);
    const tables = [];

    for (const row of tablesResult as any[]) {
      const tableName = row.name;

      // Get columns
      const columnsResult = await all(`PRAGMA table_info(${tableName})`);
      const columns = (columnsResult as any[]).map((col) => ({
        name: col.name,
        type: col.type,
        nullable: col.notnull === 0,
        default: col.dflt_value,
        primaryKey: col.pk === 1,
      }));

      // Get indexes
      const indexesResult = await all(`PRAGMA index_list(${tableName})`);
      const indexes = [];

      for (const idx of indexesResult as any[]) {
        const indexInfo = await all(`PRAGMA index_info(${idx.name})`);
        indexes.push({
          name: idx.name,
          columns: (indexInfo as any[]).map((info) => info.name),
          unique: idx.unique === 1,
        });
      }

      tables.push({ name: tableName, columns, indexes });
    }

    return { tables };
  }

  isConnected(): boolean {
    return this.db !== null;
  }
}

// ============================================================================
// Database Tool Configuration
// ============================================================================

export interface DatabaseToolConfig {
  allowedHosts: string[];
  maxQueryDuration: number;
  enableQueryValidation: boolean;
  dangerousOperations: string[]; // Operations requiring approval (DROP, TRUNCATE, DELETE without WHERE)
  maxRowsPerQuery: number;
}

const DEFAULT_CONFIG: DatabaseToolConfig = {
  allowedHosts: [],
  maxQueryDuration: 30000,
  enableQueryValidation: true,
  dangerousOperations: ["DROP", "TRUNCATE", "DELETE FROM"],
  maxRowsPerQuery: 1000,
};

// ============================================================================
// Database Tool Implementation
// ============================================================================

export class DatabaseTool extends McpTool<any, any> {
  private connections: Map<string, DatabaseConnection> = new Map();
  private config: DatabaseToolConfig;

  constructor(logger: Logger, config: Partial<DatabaseToolConfig> = {}) {
    const metadata: ToolMetadata = {
      id: "database",
      name: "Database Tool",
      description:
        "Executes database queries with validation, transactions, and schema inspection",
      version: "1.0.0",
      capabilities: [
        ToolCapability.DATABASE_ACCESS,
        ToolCapability.NETWORK_ACCESS,
      ],
      requiresApproval: true, // Database operations can be destructive
      sandboxType: SandboxType.CONTAINER,
      sandboxCapabilities: {
        network: true,
        filesystem: false,
        heavyCompute: false,
        externalBinaries: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: [
              "connect",
              "disconnect",
              "query",
              "transaction",
              "schema",
              "backup",
            ],
          },
          connectionId: { type: "string" },
          params: { type: "object" },
        },
        required: ["operation"],
      },
      outputSchema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          data: { type: "object" },
        },
      },
    };

    super(metadata, logger);
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ============================================================================
  // Tool Lifecycle
  // ============================================================================

  async initialize(): Promise<void> {
    this.emit("initialized", { tool: this.metadata.id });
  }

  async shutdown(): Promise<void> {
    // Disconnect all connections
    for (const [connectionId, connection] of this.connections) {
      await connection.disconnect();
    }
    this.connections.clear();

    this.emit("shutdown", { tool: this.metadata.id });
  }

  // ============================================================================
  // Main Execution Entry Point
  // ============================================================================

  protected async executeImpl(input: any, context: ToolContext): Promise<any> {
    const { operation, connectionId = "default", params } = input;

    switch (operation) {
      case "connect":
        return await this.connect(connectionId, params, context);
      case "disconnect":
        return await this.disconnect(connectionId);
      case "query":
        return await this.executeQuery(connectionId, params, context);
      case "transaction":
        return await this.executeTransaction(connectionId, params, context);
      case "schema":
        return await this.getSchema(connectionId, params);
      case "backup":
        return await this.backup(connectionId, params);
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  }

  protected async validateInput(input: any): Promise<void> {
    if (!input.operation) {
      throw new Error("Invalid input: operation is required");
    }
  }

  // ============================================================================
  // Connect
  // ============================================================================

  private async connect(
    connectionId: string,
    params: unknown,
    context: ToolContext,
  ): Promise<{ connected: boolean; connectionId: string }> {
    const input = ConnectionInputSchema.parse(params);

    // Validate allowed host
    if (this.config.allowedHosts.length > 0 && input.host) {
      if (!this.config.allowedHosts.includes(input.host)) {
        throw new Error(`Host ${input.host} is not in allowed list`);
      }
    }

    this.emit("connect:started", {
      connectionId,
      type: input.type,
      database: input.database,
    });

    let connection: DatabaseConnection;

    switch (input.type) {
      case "postgres":
        connection = new PostgresConnection(input);
        break;
      case "mysql":
        connection = new MySQLConnection(input);
        break;
      case "mongodb":
        connection = new MongoDBConnection(input);
        break;
      case "sqlite":
        connection = new SQLiteConnection(input);
        break;
      default:
        throw new Error(`Unsupported database type: ${input.type}`);
    }

    await connection.connect();
    this.connections.set(connectionId, connection);

    this.emit("connect:completed", { connectionId, type: input.type });

    return { connected: true, connectionId };
  }

  // ============================================================================
  // Disconnect
  // ============================================================================

  private async disconnect(
    connectionId: string,
  ): Promise<{ disconnected: boolean }> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new Error(`Connection ${connectionId} not found`);
    }

    this.emit("disconnect:started", { connectionId });

    await connection.disconnect();
    this.connections.delete(connectionId);

    this.emit("disconnect:completed", { connectionId });

    return { disconnected: true };
  }

  // ============================================================================
  // Query
  // ============================================================================

  private async executeQuery(
    connectionId: string,
    params: unknown,
    context: ToolContext,
  ): Promise<QueryOutput> {
    const input = QueryInputSchema.parse(params);
    const connection = this.connections.get(connectionId);

    if (!connection || !connection.isConnected()) {
      throw new Error(`Connection ${connectionId} not found or not connected`);
    }

    // Validate query
    if (this.config.enableQueryValidation) {
      await this.validateQuery(input.query, context);
    }

    this.emit("query:started", {
      connectionId,
      query: input.query.substring(0, 100),
    });

    const result = await connection.query(input.query, input.params);

    // Enforce max rows
    if (result.rowCount > input.maxRows) {
      result.rows = result.rows.slice(0, input.maxRows);
      result.rowCount = input.maxRows;
      this.emit("query:truncated", { connectionId, maxRows: input.maxRows });
    }

    this.emit("query:completed", {
      connectionId,
      rowCount: result.rowCount,
      duration: result.duration,
    });

    return result;
  }

  // ============================================================================
  // Transaction
  // ============================================================================

  private async executeTransaction(
    connectionId: string,
    params: unknown,
    context: ToolContext,
  ): Promise<TransactionOutput> {
    const input = TransactionInputSchema.parse(params);
    const connection = this.connections.get(connectionId);

    if (!connection || !connection.isConnected()) {
      throw new Error(`Connection ${connectionId} not found or not connected`);
    }

    // Validate all queries
    if (this.config.enableQueryValidation) {
      for (const { query } of input.queries) {
        await this.validateQuery(query, context);
      }
    }

    this.emit("transaction:started", {
      connectionId,
      queries: input.queries.length,
    });

    const result = await connection.transaction(input.queries);

    this.emit("transaction:completed", result);

    return result;
  }

  // ============================================================================
  // Schema
  // ============================================================================

  private async getSchema(
    connectionId: string,
    params: unknown,
  ): Promise<SchemaOutput> {
    const input = SchemaInputSchema.parse(params);
    const connection = this.connections.get(connectionId);

    if (!connection || !connection.isConnected()) {
      throw new Error(`Connection ${connectionId} not found or not connected`);
    }

    this.emit("schema:started", { connectionId, table: input.table });

    const result = await connection.getSchema(input.table);

    this.emit("schema:completed", {
      connectionId,
      tables: result.tables.length,
    });

    return result;
  }

  // ============================================================================
  // Backup (Simplified)
  // ============================================================================

  private async backup(
    connectionId: string,
    params: unknown,
  ): Promise<BackupOutput> {
    const input = BackupInputSchema.parse(params);
    const connection = this.connections.get(connectionId);

    if (!connection || !connection.isConnected()) {
      throw new Error(`Connection ${connectionId} not found or not connected`);
    }

    this.emit("backup:started", { connectionId, format: input.format });

    const schema = await connection.getSchema();
    const tables = input.tables || schema.tables.map((t) => t.name);

    const data: any[] = [];

    for (const tableName of tables) {
      const result = await connection.query(`SELECT * FROM ${tableName}`);
      data.push({ table: tableName, rows: result.rows });
    }

    let dumpData: string;

    if (input.format === "json") {
      dumpData = JSON.stringify(data, null, 2);
    } else {
      // Simple SQL dump
      dumpData = data
        .map((t) => {
          const inserts = t.rows
            .map((row: any) => {
              const values = Object.values(row)
                .map((v) => (typeof v === "string" ? `'${v}'` : v))
                .join(", ");
              return `INSERT INTO ${t.table} VALUES (${values});`;
            })
            .join("\n");
          return inserts;
        })
        .join("\n\n");
    }

    this.emit("backup:completed", {
      connectionId,
      size: dumpData.length,
      tables: tables.length,
    });

    return {
      success: true,
      size: dumpData.length,
      tables,
      data: dumpData,
    };
  }

  // ============================================================================
  // Query Validation
  // ============================================================================

  private async validateQuery(
    query: string,
    context: ToolContext,
  ): Promise<void> {
    const upperQuery = query.toUpperCase().trim();

    // Check for dangerous operations
    for (const dangerous of this.config.dangerousOperations) {
      if (upperQuery.includes(dangerous)) {
        // Special case: DELETE with WHERE is allowed
        if (dangerous === "DELETE FROM" && upperQuery.includes("WHERE")) {
          continue;
        }

        this.emit("query:dangerous", {
          query: query.substring(0, 100),
          operation: dangerous,
        });

        // Request approval for dangerous operations
        if (context.requestApproval) {
          const approved = await context.requestApproval(
            `Dangerous database operation: ${dangerous}`,
            { query: query.substring(0, 200) },
          );

          if (!approved) {
            throw new Error(
              `Query contains dangerous operation (${dangerous}) and was not approved`,
            );
          }
        }
      }
    }
  }
}
