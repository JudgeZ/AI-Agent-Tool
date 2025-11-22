/* eslint-disable @typescript-eslint/no-explicit-any */
// justified: gRPC callback responses and proto objects are untyped in @grpc/grpc-js
// Full type safety would require complete proto TypeScript definitions for all messages

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { Logger } from "pino";
import path from "path";

// Types for the indexer service
export interface CodeSymbol {
  id: string;
  path: string;
  name: string;
  kind: SymbolKind;
  content: string;
  embedding: number[];
  commitId?: string;
  startLine: number;
  endLine: number;
  metadata?: Record<string, string>;
  createdAt?: Date;
  updatedAt?: Date;
}

export enum SymbolKind {
  UNSPECIFIED = 0,
  FUNCTION = 1,
  CLASS = 2,
  INTERFACE = 3,
  STRUCT = 4,
  ENUM = 5,
  VARIABLE = 6,
  CONSTANT = 7,
  METHOD = 8,
  PROPERTY = 9,
  MODULE = 10,
  NAMESPACE = 11,
  TYPE = 12,
  MACRO = 13,
}

export interface Document {
  id: string;
  path: string;
  content: string;
  embedding: number[];
  commitId?: string;
  metadata?: Record<string, string>;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface SearchResult {
  symbol?: CodeSymbol;
  document?: Document;
  score: number;
  snippet: string;
}

export interface IndexStats {
  totalSymbols: number;
  totalDocuments: number;
  totalSizeBytes: number;
  indexSizeBytes: number;
  symbolsByKind: Record<string, number>;
}

export interface IndexerClientConfig {
  host: string;
  port: number;
  logger: Logger;
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

// Proto message interfaces
interface ProtoSymbol {
  id: string;
  path: string;
  name: string;
  kind: SymbolKind;
  content: string;
  embedding: number[];
  commit_id?: string;
  start_line: number;
  end_line: number;
  metadata: Record<string, string>;
  created_at?: { seconds: number; nanos: number };
  updated_at?: { seconds: number; nanos: number };
}

interface ProtoDocument {
  id: string;
  path: string;
  content: string;
  embedding: number[];
  commit_id?: string;
  metadata: Record<string, string>;
  created_at?: { seconds: number; nanos: number };
  updated_at?: { seconds: number; nanos: number };
}

interface IndexSymbolsRequest {
  symbols: CodeSymbol[];
  tenant_id?: string;
  trace_id?: string;
}

interface IndexSymbolsResponse {
  indexed_count: number;
  failed_ids: string[];
}

interface GetSymbolRequest {
  id: string;
  tenant_id?: string;
}

interface QuerySymbolsRequest {
  path?: string;
  tenant_id?: string;
}

interface SearchSymbolsRequest {
  query: string;
  top_k: number;
  path_prefix?: string;
  commit_id?: string;
  kinds: SymbolKind[];
  similarity_threshold: number;
  tenant_id?: string;
}

interface ProtoSearchResult {
  symbol?: ProtoSymbol;
  document?: ProtoDocument;
  score: number;
  snippet: string;
}

interface IndexDocumentRequest {
  document: Document;
  tenant_id?: string;
  trace_id?: string;
}

interface IndexDocumentResponse {
  document_id: string;
  embedding_dim: number;
}

interface SearchDocumentsRequest {
  query: string;
  top_k: number;
  path_prefix?: string;
  commit_id?: string;
  similarity_threshold: number;
  tenant_id?: string;
}

interface DeleteByPathRequest {
  path: string;
  tenant_id?: string;
}

interface DeleteByPathResponse {
  symbols_deleted: number;
  documents_deleted: number;
}

interface ProtoIndexStats {
  total_symbols: string; // int64 as string
  total_documents: string;
  total_size_bytes: string;
  index_size_bytes: string;
  symbols_by_kind: Record<string, number>;
}

interface HealthResponse {
  status: number;
  version: string;
  message?: string;
}

interface IndexerServiceClient extends grpc.Client {
  IndexSymbols(
    req: IndexSymbolsRequest,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<IndexSymbolsResponse>,
  ): grpc.ClientUnaryCall;
  GetSymbol(
    req: GetSymbolRequest,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<ProtoSymbol>,
  ): grpc.ClientUnaryCall;
  QuerySymbols(
    req: QuerySymbolsRequest,
    options: grpc.CallOptions,
  ): grpc.ClientReadableStream<ProtoSymbol>;
  SearchSymbols(
    req: SearchSymbolsRequest,
    options: grpc.CallOptions,
  ): grpc.ClientReadableStream<ProtoSearchResult>;
  IndexDocument(
    req: IndexDocumentRequest,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<IndexDocumentResponse>,
  ): grpc.ClientUnaryCall;
  SearchDocuments(
    req: SearchDocumentsRequest,
    options: grpc.CallOptions,
  ): grpc.ClientReadableStream<ProtoSearchResult>;
  DeleteByPath(
    req: DeleteByPathRequest,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<DeleteByPathResponse>,
  ): grpc.ClientUnaryCall;
  Checkpoint(
    req: Record<string, never>,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<Record<string, never>>,
  ): grpc.ClientUnaryCall;
  GetStats(
    req: Record<string, never>,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<ProtoIndexStats>,
  ): grpc.ClientUnaryCall;
  HealthCheck(
    req: Record<string, never>,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<HealthResponse>,
  ): grpc.ClientUnaryCall;
}

/**
 * Client for interacting with the indexer gRPC service
 */
export class IndexerClient {
  private client: IndexerServiceClient;
  private logger: Logger;
  private config: IndexerClientConfig;

  constructor(config: IndexerClientConfig) {
    this.config = {
      maxRetries: 3,
      retryDelayMs: 1000,
      timeoutMs: 30000,
      ...config,
    };
    this.logger = config.logger.child({ component: "IndexerClient" });
    this.client = this.createClient();
  }

  private createClient(): IndexerServiceClient {
    const protoPath = path.join(__dirname, "indexer.proto");
    const packageDefinition = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    const protoDescriptor = grpc.loadPackageDefinition(
      packageDefinition,
    ) as any;
    const indexerProto = protoDescriptor.indexer.v1;

    const address = `${this.config.host}:${this.config.port}`;
    this.logger.info({ address }, "Creating indexer gRPC client");

    return new indexerProto.IndexerService(
      address,
      grpc.credentials.createInsecure(),
    ) as IndexerServiceClient;
  }

  /**
   * Index multiple symbols in batch
   */
  async indexSymbols(
    symbols: CodeSymbol[],
    tenantId?: string,
    traceId?: string,
  ): Promise<{ indexedCount: number; failedIds: string[] }> {
    return this.withRetry(async () => {
      return new Promise((resolve, reject) => {
        const request = {
          symbols,
          tenant_id: tenantId,
          trace_id: traceId,
        };

        this.client.IndexSymbols(
          request,
          { deadline: this.getDeadline() },
          (error: grpc.ServiceError | null, response?: IndexSymbolsResponse) => {
            if (error) {
              this.logger.error(
                { error, tenantId, symbolCount: symbols.length },
                "Failed to index symbols",
              );
              reject(error);
            } else if (response) {
              this.logger.debug(
                {
                  indexedCount: response.indexed_count,
                  failedIds: response.failed_ids,
                },
                "Symbols indexed successfully",
              );
              resolve({
                indexedCount: response.indexed_count,
                failedIds: response.failed_ids || [],
              });
            } else {
                reject(new Error("No response received"));
            }
          },
        );
      });
    });
  }

  /**
   * Get a symbol by ID
   */
  async getSymbol(id: string, tenantId?: string): Promise<CodeSymbol> {
    return this.withRetry(async () => {
      return new Promise((resolve, reject) => {
        const request = { id, tenant_id: tenantId };

        this.client.GetSymbol(
          request,
          { deadline: this.getDeadline() },
          (error: grpc.ServiceError | null, response?: ProtoSymbol) => {
            if (error) {
              this.logger.error(
                { error, id, tenantId },
                "Failed to get symbol",
              );
              reject(error);
            } else if (response) {
              resolve(this.convertProtoSymbol(response));
            } else {
              reject(new Error("No response received"));
            }
          },
        );
      });
    });
  }

  /**
   * Query symbols by path
   */
  async querySymbols(path: string, tenantId?: string): Promise<CodeSymbol[]> {
    return this.withRetry(async () => {
      return new Promise((resolve, reject) => {
        const request = { path, tenant_id: tenantId };
        const symbols: CodeSymbol[] = [];

        const call = this.client.QuerySymbols(request, {
          deadline: this.getDeadline(),
        });

        call.on("data", (response: ProtoSymbol) => {
          symbols.push(this.convertProtoSymbol(response));
        });

        call.on("end", () => {
          this.logger.debug(
            { path, symbolCount: symbols.length },
            "Symbols queried successfully",
          );
          resolve(symbols);
        });

        call.on("error", (error: grpc.ServiceError) => {
          this.logger.error(
            { error, path, tenantId },
            "Failed to query symbols",
          );
          reject(error);
        });
      });
    });
  }

  /**
   * Search symbols using semantic similarity
   */
  async searchSymbols(
    query: string,
    topK: number = 5,
    options?: {
      pathPrefix?: string;
      commitId?: string;
      kinds?: SymbolKind[];
      similarityThreshold?: number;
      tenantId?: string;
    },
  ): Promise<SearchResult[]> {
    return this.withRetry(async () => {
      return new Promise((resolve, reject) => {
        const request = {
          query,
          top_k: topK,
          path_prefix: options?.pathPrefix,
          commit_id: options?.commitId,
          kinds: options?.kinds || [],
          similarity_threshold: options?.similarityThreshold || 0.7,
          tenant_id: options?.tenantId,
        };

        const results: SearchResult[] = [];
        const call = this.client.SearchSymbols(request, {
          deadline: this.getDeadline(),
        });

        call.on("data", (response: ProtoSearchResult) => {
          results.push({
            symbol: response.symbol
              ? this.convertProtoSymbol(response.symbol)
              : undefined,
            document: response.document
              ? this.convertProtoDocument(response.document)
              : undefined,
            score: response.score,
            snippet: response.snippet,
          });
        });

        call.on("end", () => {
          this.logger.debug(
            { query, resultCount: results.length },
            "Symbol search completed",
          );
          resolve(results);
        });

        call.on("error", (error: grpc.ServiceError) => {
          this.logger.error({ error, query }, "Failed to search symbols");
          reject(error);
        });
      });
    });
  }

  /**
   * Index a single document
   */
  async indexDocument(
    document: Document,
    tenantId?: string,
    traceId?: string,
  ): Promise<{ documentId: string; embeddingDim: number }> {
    return this.withRetry(async () => {
      return new Promise((resolve, reject) => {
        const request = {
          document,
          tenant_id: tenantId,
          trace_id: traceId,
        };

        this.client.IndexDocument(
          request,
          { deadline: this.getDeadline() },
          (error: grpc.ServiceError | null, response?: IndexDocumentResponse) => {
            if (error) {
              this.logger.error(
                { error, tenantId },
                "Failed to index document",
              );
              reject(error);
            } else if (response) {
              this.logger.debug(
                { documentId: response.document_id },
                "Document indexed successfully",
              );
              resolve({
                documentId: response.document_id,
                embeddingDim: response.embedding_dim,
              });
            } else {
                reject(new Error("No response received"));
            }
          },
        );
      });
    });
  }

  /**
   * Search documents using semantic similarity
   */
  async searchDocuments(
    query: string,
    topK: number = 5,
    options?: {
      pathPrefix?: string;
      commitId?: string;
      similarityThreshold?: number;
      tenantId?: string;
    },
  ): Promise<SearchResult[]> {
    return this.withRetry(async () => {
      return new Promise((resolve, reject) => {
        const request = {
          query,
          top_k: topK,
          path_prefix: options?.pathPrefix,
          commit_id: options?.commitId,
          similarity_threshold: options?.similarityThreshold || 0.7,
          tenant_id: options?.tenantId,
        };

        const results: SearchResult[] = [];
        const call = this.client.SearchDocuments(request, {
          deadline: this.getDeadline(),
        });

        call.on("data", (response: ProtoSearchResult) => {
          results.push({
            document: response.document
              ? this.convertProtoDocument(response.document)
              : undefined,
            score: response.score,
            snippet: response.snippet,
          });
        });

        call.on("end", () => {
          this.logger.debug(
            { query, resultCount: results.length },
            "Document search completed",
          );
          resolve(results);
        });

        call.on("error", (error: grpc.ServiceError) => {
          this.logger.error({ error, query }, "Failed to search documents");
          reject(error);
        });
      });
    });
  }

  /**
   * Delete indexed data by path
   */
  async deleteByPath(
    path: string,
    tenantId?: string,
  ): Promise<{ symbolsDeleted: number; documentsDeleted: number }> {
    return this.withRetry(async () => {
      return new Promise((resolve, reject) => {
        const request = { path, tenant_id: tenantId };

        this.client.DeleteByPath(
          request,
          { deadline: this.getDeadline() },
          (error: grpc.ServiceError | null, response?: DeleteByPathResponse) => {
            if (error) {
              this.logger.error(
                { error, path, tenantId },
                "Failed to delete by path",
              );
              reject(error);
            } else if (response) {
              this.logger.info(
                {
                  path,
                  symbolsDeleted: response.symbols_deleted,
                  documentsDeleted: response.documents_deleted,
                },
                "Deleted indexed data",
              );
              resolve({
                symbolsDeleted: response.symbols_deleted,
                documentsDeleted: response.documents_deleted,
              });
            } else {
                reject(new Error("No response received"));
            }
          },
        );
      });
    });
  }

  /**
   * Trigger a checkpoint of the index
   */
  async checkpoint(): Promise<void> {
    return this.withRetry(async () => {
      return new Promise((resolve, reject) => {
        this.client.Checkpoint(
          {},
          { deadline: this.getDeadline() },
          (error: grpc.ServiceError | null) => {
            if (error) {
              this.logger.error({ error }, "Failed to checkpoint");
              reject(error);
            } else {
              this.logger.debug("Checkpoint completed");
              resolve();
            }
          },
        );
      });
    });
  }

  /**
   * Get index statistics
   */
  async getStats(): Promise<IndexStats> {
    return this.withRetry(async () => {
      return new Promise((resolve, reject) => {
        this.client.GetStats(
          {},
          { deadline: this.getDeadline() },
          (error: grpc.ServiceError | null, response?: ProtoIndexStats) => {
            if (error) {
              this.logger.error({ error }, "Failed to get stats");
              reject(error);
            } else if (response) {
              resolve({
                totalSymbols: parseInt(response.total_symbols, 10),
                totalDocuments: parseInt(response.total_documents, 10),
                totalSizeBytes: parseInt(response.total_size_bytes, 10),
                indexSizeBytes: parseInt(response.index_size_bytes, 10),
                symbolsByKind: response.symbols_by_kind || {},
              });
            } else {
              reject(new Error("No response received"));
            }
          },
        );
      });
    });
  }

  /**
   * Health check for the indexer service
   */
  async healthCheck(): Promise<{
    status: string;
    version: string;
    message?: string;
  }> {
    return this.withRetry(async () => {
      return new Promise((resolve, reject) => {
        this.client.HealthCheck(
          {},
          { deadline: this.getDeadline() },
          (error: grpc.ServiceError | null, response?: HealthResponse) => {
            if (error) {
              this.logger.error({ error }, "Health check failed");
              reject(error);
            } else if (response) {
              resolve({
                status: this.convertHealthStatus(response.status),
                version: response.version,
                message: response.message,
              });
            } else {
                reject(new Error("No response received"));
            }
          },
        );
      });
    });
  }

  /**
   * Close the client connection
   */
  close(): void {
    this.client.close();
    this.logger.info("Indexer client closed");
  }

  // Helper methods

  private convertProtoSymbol(proto: ProtoSymbol): CodeSymbol {
    return {
      id: proto.id,
      path: proto.path,
      name: proto.name,
      kind: proto.kind,
      content: proto.content,
      embedding: proto.embedding || [],
      commitId: proto.commit_id,
      startLine: proto.start_line,
      endLine: proto.end_line,
      metadata: proto.metadata || {},
      createdAt: proto.created_at
        ? new Date(proto.created_at.seconds * 1000)
        : undefined,
      updatedAt: proto.updated_at
        ? new Date(proto.updated_at.seconds * 1000)
        : undefined,
    };
  }

  private convertProtoDocument(proto: ProtoDocument): Document {
    return {
      id: proto.id,
      path: proto.path,
      content: proto.content,
      embedding: proto.embedding || [],
      commitId: proto.commit_id,
      metadata: proto.metadata || {},
      createdAt: proto.created_at
        ? new Date(proto.created_at.seconds * 1000)
        : undefined,
      updatedAt: proto.updated_at
        ? new Date(proto.updated_at.seconds * 1000)
        : undefined,
    };
  }

  private convertHealthStatus(status: number): string {
    switch (status) {
      case 1:
        return "healthy";
      case 2:
        return "degraded";
      case 3:
        return "unhealthy";
      default:
        return "unknown";
    }
  }

  private getDeadline(): Date {
    return new Date(Date.now() + (this.config.timeoutMs || 30000));
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    const maxRetries = this.config.maxRetries || 3;
    const retryDelay = this.config.retryDelayMs || 1000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        const isRetryable =
          error.code === grpc.status.UNAVAILABLE ||
          error.code === grpc.status.DEADLINE_EXCEEDED;

        if (attempt < maxRetries && isRetryable) {
          this.logger.warn(
            { attempt, maxRetries, error: error.message, code: error.code },
            "Retrying indexer request",
          );
          await new Promise((resolve) =>
            setTimeout(resolve, retryDelay * Math.pow(2, attempt)),
          );
        } else {
          throw error;
        }
      }
    }

    throw new Error("Unreachable");
  }
}
