# Architecture Overview — OSS AI Agent Tool

The system combines a low-latency **inner loop** (gRPC/HTTP + SSE) with a durable **outer loop** (RabbitMQ or Kafka) to orchestrate multi-agent workflows for both **consumer** and **enterprise** deployments.

```mermaid
flowchart LR
  GUI((Desktop GUI / VS Code)) -->|SSE| GW[Gateway API]
  GW -->|gRPC/HTTP| ORCH[Orchestrator]
  GW -->|gRPC/HTTP| IDX[Indexing Svc]
  ORCH --> PRV[Model Provider Registry]

  subgraph Data Plane
    REDIS[(Redis)]
    PG[(Postgres)]
    RMQ>RabbitMQ]
    KAFKA>Kafka]
  end

  subgraph Observability
    JAEGER((Jaeger / OTLP))
    LANGFUSE((Langfuse))
  end

  ORCH --> REDIS
  ORCH --> PG
  ORCH --> RMQ
  ORCH --> KAFKA
  ORCH --> JAEGER
  ORCH --> LANGFUSE

  subgraph Agents & Tools
    A1[Code Writer]:::agent
    A2[Security Auditor]:::agent
    A3[Planner]:::agent
  end

  RMQ <---> A1
  RMQ <---> A2
  RMQ <---> A3

  KAFKA -. events .- A1
  KAFKA -. events .- A2
  KAFKA -. events .- A3

  classDef agent fill:#eef,stroke:#66f;
```

**Key properties**
- **SSE** for efficient UI streaming.
- **Hybrid context engine** (symbolic + semantic + temporal).
- **Multi‑bus**: RabbitMQ (tasks) alongside Kafka (event backbone / fan-out).
- **Stateful services**: Redis for low-latency cache/vector search; Postgres for durable history, audit, and Langfuse storage.
- **Multi‑provider** model routing (OpenAI, Anthropic, Gemini, Azure OpenAI, Bedrock, Mistral, OpenRouter, Local/Ollama).
- **Observability**: OpenTelemetry traces, Jaeger; structured logs; metrics dashboards.
- **Security**: least privilege, approvals, sandboxing, egress allow-lists, signed images and SBOMs.
