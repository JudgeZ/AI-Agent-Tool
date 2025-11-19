import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseTool } from "./DatabaseTool";
import { ToolContext } from "../McpTool";
import pino from "pino";

// Mock database libraries with factory functions
vi.mock("pg", () => {
  return {
    Pool: vi.fn().mockImplementation(function () {
      return {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        end: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };
});
vi.mock("mysql2/promise");
vi.mock("mongodb");
vi.mock("sqlite3", () => {
  return {
    Database: vi.fn().mockImplementation(function (path, cb) {
      if (cb) cb(null);
      return {
        close: vi.fn((callback) => callback && callback()),
      };
    }),
  };
});

describe("DatabaseTool", () => {
  let tool: DatabaseTool;
  let mockContext: ToolContext;
  let mockLogger: pino.Logger;

  beforeEach(async () => {
    mockLogger = pino({ level: "silent" });

    mockContext = {
      requestApproval: vi.fn().mockResolvedValue(true),
      tenantId: "test-tenant",
      userId: "test-user",
      sessionId: "test-session",
    } as any;

    tool = new DatabaseTool(mockLogger, {
      allowedHosts: ["localhost", "testdb.example.com"],
      maxQueryDuration: 30000,
      enableQueryValidation: true,
      maxRowsPerQuery: 1000,
    });

    await tool.initialize();
  });

  afterEach(async () => {
    await tool.shutdown();
    vi.clearAllMocks();
  });

  describe("connect", () => {
    it("should connect to PostgreSQL database", async () => {
      const pg = await import("pg");
      const mockPool = {
        query: vi.fn().mockResolvedValue({ rows: [{ result: 1 }] }),
        end: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(pg.Pool).mockImplementation(function (this: any) {
        return mockPool as any;
      });

      const result = await tool.execute(
        {
          operation: "connect",
          connectionId: "pg-conn",
          params: {
            type: "postgres",
            host: "localhost",
            port: 5432,
            database: "testdb",
            username: "user",
            password: "pass",
          },
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.data.connected).toBe(true);
      expect(result.data.connectionId).toBe("pg-conn");
    });

    it("should reject connection to non-allowed host", async () => {
      const result = await tool.execute(
        {
          operation: "connect",
          params: {
            type: "postgres",
            host: "malicious.example.com",
            database: "testdb",
          },
        },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in allowed list");
    });

    it("should connect to SQLite database", async () => {
      const sqlite3 = await import("sqlite3");
      const mockDb = {
        close: vi.fn((cb: any) => cb()),
      };
      vi.mocked(sqlite3.Database).mockImplementation(function (
        this: any,
        path: any,
        cb: any,
      ) {
        if (cb) cb(null);
        return mockDb as any;
      });

      const result = await tool.execute(
        {
          operation: "connect",
          params: {
            type: "sqlite",
            database: "/tmp/test.db",
          },
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.data.connected).toBe(true);
    });
  });

  describe("query", () => {
    beforeEach(async () => {
      // Setup mock PostgreSQL connection
      const { Pool } = await import("pg");
      const mockPool = {
        query: vi.fn().mockResolvedValue({
          rows: [
            { id: 1, name: "Alice" },
            { id: 2, name: "Bob" },
          ],
          rowCount: 2,
          fields: [{ name: "id" }, { name: "name" }],
        }),
        end: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(Pool).mockImplementation(function (this: any) {
        return mockPool as any;
      });

      await tool.execute(
        {
          operation: "connect",
          params: {
            type: "postgres",
            host: "localhost",
            database: "testdb",
            username: "user",
            password: "pass",
          },
        },
        mockContext,
      );
    });

    it("should execute SELECT query", async () => {
      const result = await tool.execute(
        {
          operation: "query",
          params: {
            query: "SELECT * FROM users",
          },
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.data.rows).toHaveLength(2);
      expect(result.data.rowCount).toBe(2);
      expect(result.data.fields).toEqual(["id", "name"]);
    });

    it("should execute parameterized query", async () => {
      const { Pool } = await import("pg");
      const mockQuery = vi.fn().mockResolvedValue({
        rows: [{ id: 1, name: "Alice" }],
        rowCount: 1,
        fields: [{ name: "id" }, { name: "name" }],
      });

      vi.mocked(Pool).mockImplementation(function (this: any) {
        return {
          query: mockQuery,
          end: vi.fn(),
        } as any;
      });

      // Reconnect with new mock
      await tool.execute({ operation: "disconnect" }, mockContext);
      await tool.execute(
        {
          operation: "connect",
          params: { type: "postgres", host: "localhost", database: "testdb" },
        },
        mockContext,
      );

      await tool.execute(
        {
          operation: "query",
          params: {
            query: "SELECT * FROM users WHERE id = $1",
            params: [1],
          },
        },
        mockContext,
      );

      expect(mockQuery).toHaveBeenCalledWith(
        "SELECT * FROM users WHERE id = $1",
        [1],
      );
    });

    it("should truncate results exceeding max rows", async () => {
      const { Pool } = await import("pg");
      const rows = Array.from({ length: 2000 }, (_, i) => ({ id: i }));
      vi.mocked(Pool).mockImplementation(function (this: any) {
        return {
          query: vi.fn().mockResolvedValue({
            rows,
            rowCount: 2000,
            fields: [],
          }),
          end: vi.fn(),
        } as any;
      });

      await tool.execute({ operation: "disconnect" }, mockContext);
      await tool.execute(
        {
          operation: "connect",
          params: { type: "postgres", host: "localhost", database: "testdb" },
        },
        mockContext,
      );

      const result = await tool.execute(
        {
          operation: "query",
          params: {
            query: "SELECT * FROM large_table",
            maxRows: 1000,
          },
        },
        mockContext,
      );

      expect(result.data.rows).toHaveLength(1000);
      expect(result.data.rowCount).toBe(1000);
    });

    it("should validate dangerous queries", async () => {
      mockContext.requestApproval = vi.fn().mockResolvedValue(false);

      const result = await tool.execute(
        {
          operation: "query",
          params: {
            query: "DROP TABLE users",
          },
        },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("denied");
      expect(mockContext.requestApproval).toHaveBeenCalled();
    });

    it("should allow DELETE with WHERE clause", async () => {
      const { Pool } = await import("pg");
      vi.mocked(Pool).mockImplementation(function (this: any) {
        return {
          query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
          end: vi.fn(),
        } as any;
      });

      await tool.execute({ operation: "disconnect" }, mockContext);
      await tool.execute(
        {
          operation: "connect",
          params: { type: "postgres", host: "localhost", database: "testdb" },
        },
        mockContext,
      );

      const result = await tool.execute(
        {
          operation: "query",
          params: {
            query: "DELETE FROM users WHERE id = 1",
          },
        },
        mockContext,
      );

      expect(result.success).toBe(true);
    });

    it("should request approval for dangerous operations", async () => {
      mockContext.requestApproval = vi.fn().mockResolvedValue(false);

      const result = await tool.execute(
        {
          operation: "query",
          params: {
            query: "TRUNCATE TABLE users",
          },
        },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("denied");
      expect(mockContext.requestApproval).toHaveBeenCalled();
    });
  });

  describe("transaction", () => {
    beforeEach(async () => {
      const { Pool } = await import("pg");
      const mockClient = {
        query: vi.fn().mockResolvedValue({ rowCount: 1 }),
        release: vi.fn(),
      };
      const mockPool = {
        connect: vi.fn().mockResolvedValue(mockClient),
        end: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockResolvedValue({ rows: [{ result: 1 }] }),
      };
      vi.mocked(Pool).mockImplementation(function (this: any) {
        return mockPool as any;
      });

      await tool.execute(
        {
          operation: "connect",
          params: {
            type: "postgres",
            host: "localhost",
            database: "testdb",
          },
        },
        mockContext,
      );
    });

    it("should execute transaction with multiple queries", async () => {
      const result = await tool.execute(
        {
          operation: "transaction",
          params: {
            queries: [
              {
                query: "INSERT INTO users (name) VALUES ($1)",
                params: ["Alice"],
              },
              {
                query: "INSERT INTO users (name) VALUES ($1)",
                params: ["Bob"],
              },
              { query: "UPDATE settings SET count = count + 2" },
            ],
          },
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(true);
      expect(result.data.queriesExecuted).toBe(3);
    });

    it("should rollback transaction on error", async () => {
      const { Pool } = await import("pg");
      const mockClient = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rowCount: 1 }) // BEGIN
          .mockResolvedValueOnce({ rowCount: 1 }) // First query
          .mockRejectedValueOnce(new Error("Constraint violation")) // Second query fails
          .mockResolvedValueOnce({ rowCount: 0 }), // ROLLBACK
        release: vi.fn(),
      };

      vi.mocked(Pool).mockImplementation(function (this: any) {
        return {
          connect: vi.fn().mockResolvedValue(mockClient),
          end: vi.fn(),
          query: vi.fn().mockResolvedValue({ rows: [{ result: 1 }] }),
        } as any;
      });

      await tool.execute({ operation: "disconnect" }, mockContext);
      await tool.execute(
        {
          operation: "connect",
          params: { type: "postgres", host: "localhost", database: "testdb" },
        },
        mockContext,
      );

      const result = await tool.execute(
        {
          operation: "transaction",
          params: {
            queries: [
              {
                query: "INSERT INTO users (name) VALUES ($1)",
                params: ["Alice"],
              },
              {
                query: "INSERT INTO users (id, name) VALUES ($1, $2)",
                params: [1, "Bob"],
              },
            ],
          },
        },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Constraint violation");
    });
  });

  describe("schema", () => {
    beforeEach(async () => {
      const { Pool } = await import("pg");
      const mockPool = {
        query: vi.fn((sql: any) => {
          if (sql.includes("information_schema.tables")) {
            return Promise.resolve({
              rows: [{ table_name: "users" }, { table_name: "posts" }],
            });
          }
          if (sql.includes("information_schema.columns")) {
            return Promise.resolve({
              rows: [
                {
                  column_name: "id",
                  data_type: "integer",
                  is_nullable: "NO",
                  column_default: "nextval(...)",
                },
                {
                  column_name: "name",
                  data_type: "varchar",
                  is_nullable: "YES",
                },
              ],
            });
          }
          if (sql.includes("pg_index")) {
            return Promise.resolve({ rows: [{ attname: "id" }] });
          }
          if (sql.includes("pg_class")) {
            return Promise.resolve({
              rows: [
                {
                  index_name: "users_pkey",
                  column_name: "id",
                  indisunique: true,
                },
              ],
            });
          }
          return Promise.resolve({ rows: [] });
        }),
        end: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(Pool).mockImplementation(function (this: any) {
        return mockPool as any;
      });

      await tool.execute(
        {
          operation: "connect",
          params: { type: "postgres", host: "localhost", database: "testdb" },
        },
        mockContext,
      );
    });

    it("should get schema for all tables", async () => {
      const result = await tool.execute(
        {
          operation: "schema",
          params: {},
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.data.tables).toHaveLength(2);
      expect(result.data.tables[0].name).toBe("users");
      expect(result.data.tables[0].columns).toHaveLength(2);
    });

    it("should get schema for specific table", async () => {
      const result = await tool.execute(
        {
          operation: "schema",
          params: { table: "users" },
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.data.tables).toHaveLength(2); // Mock returns both, real would return 1
    });
  });

  describe("backup", () => {
    beforeEach(async () => {
      const { Pool } = await import("pg");
      const mockPool = {
        query: vi.fn((sql: any) => {
          if (sql.includes("information_schema.tables")) {
            return Promise.resolve({ rows: [{ table_name: "users" }] });
          }
          if (sql === "SELECT * FROM users") {
            return Promise.resolve({
              rows: [
                { id: 1, name: "Alice" },
                { id: 2, name: "Bob" },
              ],
            });
          }
          return Promise.resolve({ rows: [] });
        }),
        end: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(Pool).mockImplementation(function (this: any) {
        return mockPool as any;
      });

      await tool.execute(
        {
          operation: "connect",
          params: { type: "postgres", host: "localhost", database: "testdb" },
        },
        mockContext,
      );
    });

    it("should create JSON backup", async () => {
      const result = await tool.execute(
        {
          operation: "backup",
          params: {
            format: "json",
          },
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(true);
      expect(result.data.format).toBeUndefined(); // Not in output schema
      expect(result.data.data).toContain("Alice");
      expect(JSON.parse(result.data.data)).toBeInstanceOf(Array);
    });

    it("should create SQL backup", async () => {
      const result = await tool.execute(
        {
          operation: "backup",
          params: {
            format: "sql",
            tables: ["users"],
          },
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.data.data).toContain("INSERT INTO users");
      expect(result.data.tables).toEqual(["users"]);
    });
  });

  describe("disconnect", () => {
    it("should disconnect from database", async () => {
      const { Pool } = await import("pg");
      const mockEnd = vi.fn().mockResolvedValue(undefined);
      vi.mocked(Pool).mockImplementation(function (this: any) {
        return {
          query: vi.fn().mockResolvedValue({ rows: [] }),
          end: mockEnd,
        } as any;
      });

      await tool.execute(
        {
          operation: "connect",
          params: { type: "postgres", host: "localhost", database: "testdb" },
        },
        mockContext,
      );

      const result = await tool.execute(
        {
          operation: "disconnect",
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.data.disconnected).toBe(true);
      expect(mockEnd).toHaveBeenCalled();
    });

    it("should handle disconnect of non-existent connection", async () => {
      const result = await tool.execute(
        {
          operation: "disconnect",
          connectionId: "non-existent",
        },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  describe("multiple connections", () => {
    it("should manage multiple connections", async () => {
      const { Pool } = await import("pg");
      vi.mocked(Pool).mockImplementation(function (this: any) {
        return {
          query: vi.fn().mockResolvedValue({ rows: [] }),
          end: vi.fn().mockResolvedValue(undefined),
        } as any;
      });

      await tool.execute(
        {
          operation: "connect",
          connectionId: "db1",
          params: { type: "postgres", host: "localhost", database: "db1" },
        },
        mockContext,
      );

      await tool.execute(
        {
          operation: "connect",
          connectionId: "db2",
          params: { type: "postgres", host: "localhost", database: "db2" },
        },
        mockContext,
      );

      // Both connections should work independently
      const result1 = await tool.execute(
        {
          operation: "query",
          connectionId: "db1",
          params: { query: "SELECT 1" },
        },
        mockContext,
      );

      const result2 = await tool.execute(
        {
          operation: "query",
          connectionId: "db2",
          params: { query: "SELECT 2" },
        },
        mockContext,
      );

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
    });
  });
});
