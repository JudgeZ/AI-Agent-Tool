import { EventEmitter } from "events";
import {
  ExecutionGraph,
  ExecutionResult,
  NodeExecution,
  NodeStatus,
} from "./ExecutionGraph";
import { PipelineType } from "./StandardPipelines";

// ============================================================================
// Monitoring Types
// ============================================================================

/**
 * Event types emitted by ExecutionGraph
 */
export interface NodeStartedEvent {
  nodeId: string;
  nodeName?: string;
  timestamp?: Date;
}

export interface NodeCompletedEvent {
  nodeId: string;
  nodeName?: string;
  duration: number;
  output?: any; // Output is intentionally dynamic - varies by node type
  timestamp?: Date;
}

export interface NodeFailedEvent {
  nodeId: string;
  nodeName?: string;
  error: Error;
  attempts: number;
  timestamp?: Date;
}

export interface PipelineMetrics {
  pipelineId: string;
  executionId: string;
  type: PipelineType;
  status: "running" | "completed" | "failed" | "cancelled";
  startTime: Date;
  endTime?: Date;
  duration?: number;
  nodeMetrics: NodeMetrics[];
  performance: PerformanceMetrics;
  bottlenecks: Bottleneck[];
}

export interface NodeMetrics {
  nodeId: string;
  nodeName: string;
  status: NodeStatus;
  startTime?: Date;
  endTime?: Date;
  duration?: number;
  attempts: number;
  waitTime: number; // Time spent waiting for dependencies
  executionTime: number; // Actual execution time
  cpuUsage?: number;
  memoryUsage?: number;
}

export interface PerformanceMetrics {
  totalNodes: number;
  completedNodes: number;
  failedNodes: number;
  averageNodeDuration: number;
  longestNode: {
    nodeId: string;
    duration: number;
  };
  parallelismUtilization: number; // 0-1, how well parallelism was used
  criticalPath: string[]; // Node IDs on the critical path
  criticalPathDuration: number;
}

export interface Bottleneck {
  nodeId: string;
  nodeName: string;
  type: BottleneckType;
  severity: "low" | "medium" | "high" | "critical";
  impact: number; // Impact on overall execution time (in ms)
  description: string;
  recommendation: string;
}

export enum BottleneckType {
  LONG_EXECUTION = "long_execution",
  HIGH_WAIT_TIME = "high_wait_time",
  FREQUENT_RETRIES = "frequent_retries",
  RESOURCE_CONTENTION = "resource_contention",
  SERIALIZATION = "serialization",
}

// ============================================================================
// Real-Time Pipeline Monitor
// ============================================================================

export class PipelineMonitor extends EventEmitter {
  private graphs: Map<string, MonitoredGraph> = new Map();
  private history: Map<string, PipelineMetrics> = new Map();
  private maxHistorySize: number;

  constructor(maxHistorySize: number = 1000) {
    super();
    this.maxHistorySize = maxHistorySize;
  }

  // ============================================================================
  // Graph Monitoring
  // ============================================================================

  public monitor(graph: ExecutionGraph, type: PipelineType): string {
    const pipelineId = graph.getDefinition().id;
    const executionId = graph.getContext().executionId;

    const monitored: MonitoredGraph = {
      graph,
      type,
      startTime: new Date(),
      nodeStartTimes: new Map(),
      nodeWaitTimes: new Map(),
    };

    this.graphs.set(executionId, monitored);

    // Subscribe to graph events
    this.subscribeToEvents(graph, executionId);

    this.emit("monitoring:started", { pipelineId, executionId, type });

    return executionId;
  }

  private subscribeToEvents(graph: ExecutionGraph, executionId: string): void {
    // Execution lifecycle
    graph.on("execution:started", (event) => {
      this.emit("pipeline:started", { executionId, ...event });
    });

    graph.on("execution:completed", (event) => {
      this.handleExecutionCompleted(executionId, event);
    });

    graph.on("execution:failed", (event) => {
      this.handleExecutionFailed(executionId, event);
    });

    // Node lifecycle
    graph.on("node:started", (event) => {
      this.handleNodeStarted(executionId, event);
    });

    graph.on("node:completed", (event) => {
      this.handleNodeCompleted(executionId, event);
    });

    graph.on("node:failed", (event) => {
      this.handleNodeFailed(executionId, event);
    });

    graph.on("node:retry", (event) => {
      this.emit("node:retry", { executionId, ...event });
    });

    graph.on("node:blocked", (event) => {
      this.emit("node:blocked", { executionId, ...event });
    });
  }

  // ============================================================================
  // Event Handlers
  // ============================================================================

  private handleNodeStarted(
    executionId: string,
    event: NodeStartedEvent,
  ): void {
    const monitored = this.graphs.get(executionId);
    if (!monitored) return;

    const now = Date.now();
    monitored.nodeStartTimes.set(event.nodeId, now);

    // Calculate wait time (time from pipeline start to node start)
    const waitTime = now - monitored.startTime.getTime();
    monitored.nodeWaitTimes.set(event.nodeId, waitTime);

    this.emit("node:started", {
      executionId,
      nodeId: event.nodeId,
      waitTime,
      timestamp: new Date(),
    });
  }

  private handleNodeCompleted(
    executionId: string,
    event: NodeCompletedEvent,
  ): void {
    const monitored = this.graphs.get(executionId);
    if (!monitored) return;

    this.emit("node:completed", {
      executionId,
      nodeId: event.nodeId,
      duration: event.duration,
      timestamp: new Date(),
    });

    // Check for potential bottlenecks
    this.detectNodeBottlenecks(executionId, event.nodeId, event.duration);
  }

  private handleNodeFailed(executionId: string, event: NodeFailedEvent): void {
    this.emit("node:failed", {
      executionId,
      nodeId: event.nodeId,
      error: event.error,
      attempts: event.attempts,
      timestamp: new Date(),
    });
  }

  private handleExecutionCompleted(
    executionId: string,
    result: ExecutionResult,
  ): void {
    const monitored = this.graphs.get(executionId);
    if (!monitored) return;

    const metrics = this.calculateMetrics(executionId, monitored, result);
    this.storeMetrics(executionId, metrics);

    this.emit("pipeline:completed", {
      executionId,
      metrics,
      timestamp: new Date(),
    });

    // Cleanup
    this.graphs.delete(executionId);
  }

  private handleExecutionFailed(
    executionId: string,
    result: ExecutionResult,
  ): void {
    const monitored = this.graphs.get(executionId);
    if (!monitored) return;

    const metrics = this.calculateMetrics(executionId, monitored, result);
    metrics.status = "failed";
    this.storeMetrics(executionId, metrics);

    this.emit("pipeline:failed", {
      executionId,
      metrics,
      error: result.error,
      timestamp: new Date(),
    });

    // Cleanup
    this.graphs.delete(executionId);
  }

  // ============================================================================
  // Metrics Calculation
  // ============================================================================

  private calculateMetrics(
    executionId: string,
    monitored: MonitoredGraph,
    result: ExecutionResult,
  ): PipelineMetrics {
    const nodeMetrics = this.calculateNodeMetrics(
      monitored,
      result.nodeExecutions,
    );
    const performance = this.calculatePerformanceMetrics(
      nodeMetrics,
      monitored,
    );
    const bottlenecks = this.detectBottlenecks(nodeMetrics, performance);

    return {
      pipelineId: result.graphId,
      executionId,
      type: monitored.type,
      status: result.success ? "completed" : "failed",
      startTime: monitored.startTime,
      endTime: new Date(),
      duration: result.duration,
      nodeMetrics,
      performance,
      bottlenecks,
    };
  }

  private calculateNodeMetrics(
    monitored: MonitoredGraph,
    executions: NodeExecution[],
  ): NodeMetrics[] {
    return executions.map((exec) => {
      const waitTime = monitored.nodeWaitTimes.get(exec.nodeId) || 0;
      const executionTime = exec.duration || 0;

      return {
        nodeId: exec.nodeId,
        nodeName: this.getNodeName(monitored.graph, exec.nodeId),
        status: exec.status,
        startTime: exec.startTime,
        endTime: exec.endTime,
        duration: exec.duration,
        attempts: exec.attempts,
        waitTime,
        executionTime,
      };
    });
  }

  private calculatePerformanceMetrics(
    nodeMetrics: NodeMetrics[],
    monitored: MonitoredGraph,
  ): PerformanceMetrics {
    const completedNodes = nodeMetrics.filter(
      (n) => n.status === NodeStatus.COMPLETED,
    );
    const failedNodes = nodeMetrics.filter(
      (n) => n.status === NodeStatus.FAILED,
    );

    const avgDuration =
      completedNodes.reduce((sum, n) => sum + (n.duration || 0), 0) /
        completedNodes.length || 0;

    const longestNode = completedNodes.reduce(
      (max, n) =>
        (n.duration || 0) > max.duration
          ? { nodeId: n.nodeId, duration: n.duration! }
          : max,
      { nodeId: "", duration: 0 },
    );

    // Calculate critical path
    const { path, duration } = this.calculateCriticalPath(
      monitored.graph,
      nodeMetrics,
    );

    // Calculate parallelism utilization
    const parallelismUtilization = this.calculateParallelismUtilization(
      nodeMetrics,
      duration,
    );

    return {
      totalNodes: nodeMetrics.length,
      completedNodes: completedNodes.length,
      failedNodes: failedNodes.length,
      averageNodeDuration: avgDuration,
      longestNode,
      parallelismUtilization,
      criticalPath: path,
      criticalPathDuration: duration,
    };
  }

  private calculateCriticalPath(
    graph: ExecutionGraph,
    nodeMetrics: NodeMetrics[],
  ): { path: string[]; duration: number } {
    const definition = graph.getDefinition();
    const metricsMap = new Map(nodeMetrics.map((m) => [m.nodeId, m]));

    // Build dependency graph with durations
    const longestPaths = new Map<
      string,
      { duration: number; path: string[] }
    >();

    const calculatePath = (
      nodeId: string,
    ): { duration: number; path: string[] } => {
      if (longestPaths.has(nodeId)) {
        return longestPaths.get(nodeId)!;
      }

      const node = definition.nodes.find((n) => n.id === nodeId);
      const metrics = metricsMap.get(nodeId);
      const nodeDuration = metrics?.duration || 0;

      if (!node || node.dependencies.length === 0) {
        const result = { duration: nodeDuration, path: [nodeId] };
        longestPaths.set(nodeId, result);
        return result;
      }

      // Find longest path through dependencies
      let maxDepPath = { duration: 0, path: [] as string[] };
      for (const depId of node.dependencies) {
        const depPath = calculatePath(depId);
        if (depPath.duration > maxDepPath.duration) {
          maxDepPath = depPath;
        }
      }

      const result = {
        duration: maxDepPath.duration + nodeDuration,
        path: [...maxDepPath.path, nodeId],
      };
      longestPaths.set(nodeId, result);
      return result;
    };

    // Calculate for all leaf nodes
    let criticalPath = { duration: 0, path: [] as string[] };
    for (const node of definition.nodes) {
      const path = calculatePath(node.id);
      if (path.duration > criticalPath.duration) {
        criticalPath = path;
      }
    }

    return criticalPath;
  }

  private calculateParallelismUtilization(
    nodeMetrics: NodeMetrics[],
    totalDuration: number,
  ): number {
    if (totalDuration === 0) return 0;

    const totalNodeTime = nodeMetrics.reduce(
      (sum, n) => sum + (n.duration || 0),
      0,
    );
    const theoreticalParallelTime = totalNodeTime;
    const actualTime = totalDuration;

    // Utilization = (theoretical parallel time) / (actual time * node count)
    const utilization = totalNodeTime / (actualTime * nodeMetrics.length);
    return Math.min(1, utilization);
  }

  // ============================================================================
  // Bottleneck Detection
  // ============================================================================

  private detectNodeBottlenecks(
    executionId: string,
    nodeId: string,
    duration: number,
  ): void {
    // Real-time bottleneck detection
    const threshold = 60000; // 1 minute

    if (duration > threshold) {
      this.emit("bottleneck:detected", {
        executionId,
        nodeId,
        type: BottleneckType.LONG_EXECUTION,
        duration,
        timestamp: new Date(),
      });
    }
  }

  private detectBottlenecks(
    nodeMetrics: NodeMetrics[],
    performance: PerformanceMetrics,
  ): Bottleneck[] {
    const bottlenecks: Bottleneck[] = [];

    // Detect long-running nodes
    const avgDuration = performance.averageNodeDuration;
    for (const node of nodeMetrics) {
      if (node.status !== NodeStatus.COMPLETED) continue;

      const duration = node.duration || 0;

      // Long execution
      if (duration > avgDuration * 3) {
        bottlenecks.push({
          nodeId: node.nodeId,
          nodeName: node.nodeName,
          type: BottleneckType.LONG_EXECUTION,
          severity: this.calculateSeverity(duration, avgDuration),
          impact: duration - avgDuration,
          description: `Node took ${(duration / 1000).toFixed(1)}s, ${(duration / avgDuration).toFixed(1)}x longer than average`,
          recommendation:
            "Consider optimizing this operation or breaking it into smaller steps",
        });
      }

      // High wait time
      if (node.waitTime > duration * 2) {
        bottlenecks.push({
          nodeId: node.nodeId,
          nodeName: node.nodeName,
          type: BottleneckType.HIGH_WAIT_TIME,
          severity: "medium",
          impact: node.waitTime,
          description: `Node waited ${(node.waitTime / 1000).toFixed(1)}s before execution`,
          recommendation:
            "Review dependencies and consider parallelizing more operations",
        });
      }

      // Frequent retries
      if (node.attempts > 3) {
        bottlenecks.push({
          nodeId: node.nodeId,
          nodeName: node.nodeName,
          type: BottleneckType.FREQUENT_RETRIES,
          severity: "high",
          impact: duration * (node.attempts - 1),
          description: `Node required ${node.attempts} attempts to complete`,
          recommendation: "Investigate and fix underlying reliability issues",
        });
      }
    }

    // Detect serialization bottlenecks (nodes on critical path)
    for (const nodeId of performance.criticalPath) {
      const node = nodeMetrics.find((n) => n.nodeId === nodeId);
      if (!node) continue;

      const isAlreadyFlagged = bottlenecks.some((b) => b.nodeId === nodeId);
      if (
        !isAlreadyFlagged &&
        node.duration &&
        node.duration > avgDuration * 1.5
      ) {
        bottlenecks.push({
          nodeId: node.nodeId,
          nodeName: node.nodeName,
          type: BottleneckType.SERIALIZATION,
          severity: "high",
          impact: node.duration,
          description: `Node is on critical path and blocks ${performance.criticalPath.length} other nodes`,
          recommendation:
            "Consider parallelizing this operation or reducing its dependencies",
        });
      }
    }

    // Sort by impact
    bottlenecks.sort((a, b) => b.impact - a.impact);

    return bottlenecks;
  }

  private calculateSeverity(
    duration: number,
    avgDuration: number,
  ): "low" | "medium" | "high" | "critical" {
    const ratio = duration / avgDuration;
    if (ratio > 10) return "critical";
    if (ratio > 5) return "high";
    if (ratio > 3) return "medium";
    return "low";
  }

  // ============================================================================
  // Metrics Storage and Retrieval
  // ============================================================================

  private storeMetrics(executionId: string, metrics: PipelineMetrics): void {
    this.history.set(executionId, metrics);

    // Cleanup old history
    if (this.history.size > this.maxHistorySize) {
      const oldestKey = this.history.keys().next().value as string;
      this.history.delete(oldestKey);
    }
  }

  public getMetrics(executionId: string): PipelineMetrics | undefined {
    return this.history.get(executionId);
  }

  public getRecentMetrics(count: number = 10): PipelineMetrics[] {
    const entries = Array.from(this.history.values());
    return entries.slice(-count);
  }

  public getMetricsByType(type: PipelineType): PipelineMetrics[] {
    return Array.from(this.history.values()).filter((m) => m.type === type);
  }

  public getAggregatedMetrics(type?: PipelineType): AggregatedMetrics {
    const metrics = type
      ? this.getMetricsByType(type)
      : Array.from(this.history.values());

    if (metrics.length === 0) {
      return {
        totalExecutions: 0,
        successRate: 0,
        averageDuration: 0,
        p50Duration: 0,
        p95Duration: 0,
        p99Duration: 0,
        commonBottlenecks: [],
      };
    }

    const successful = metrics.filter((m) => m.status === "completed");
    const durations = metrics.map((m) => m.duration || 0).sort((a, b) => a - b);

    // Calculate percentiles
    const p50 = durations[Math.floor(durations.length * 0.5)] || 0;
    const p95 = durations[Math.floor(durations.length * 0.95)] || 0;
    const p99 = durations[Math.floor(durations.length * 0.99)] || 0;

    // Find common bottlenecks
    const bottleneckCounts = new Map<string, number>();
    for (const metric of metrics) {
      for (const bottleneck of metric.bottlenecks) {
        const key = `${bottleneck.nodeId}:${bottleneck.type}`;
        bottleneckCounts.set(key, (bottleneckCounts.get(key) || 0) + 1);
      }
    }

    const commonBottlenecks = Array.from(bottleneckCounts.entries())
      .map(([key, count]) => {
        const [nodeId, type] = key.split(":");
        return { nodeId, type: type as BottleneckType, occurrences: count };
      })
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, 5);

    return {
      totalExecutions: metrics.length,
      successRate: successful.length / metrics.length,
      averageDuration:
        durations.reduce((sum, d) => sum + d, 0) / durations.length,
      p50Duration: p50,
      p95Duration: p95,
      p99Duration: p99,
      commonBottlenecks,
    };
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  private getNodeName(graph: ExecutionGraph, nodeId: string): string {
    const node = graph.getDefinition().nodes.find((n) => n.id === nodeId);
    return node?.name || nodeId;
  }

  public shutdown(): void {
    this.graphs.clear();
    this.emit("shutdown");
  }
}

// ============================================================================
// Supporting Types
// ============================================================================

interface MonitoredGraph {
  graph: ExecutionGraph;
  type: PipelineType;
  startTime: Date;
  nodeStartTimes: Map<string, number>;
  nodeWaitTimes: Map<string, number>;
}

export interface AggregatedMetrics {
  totalExecutions: number;
  successRate: number;
  averageDuration: number;
  p50Duration: number;
  p95Duration: number;
  p99Duration: number;
  commonBottlenecks: Array<{
    nodeId: string;
    type: BottleneckType;
    occurrences: number;
  }>;
}
