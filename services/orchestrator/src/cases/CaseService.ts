import { randomUUID } from "node:crypto";

export type CaseStatus = "open" | "in_progress" | "closed";

export interface CaseRecord {
  id: string;
  tenantId?: string;
  projectId?: string;
  title: string;
  description?: string;
  status: CaseStatus;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
  tasks: TaskRecord[];
  artifacts: ArtifactRecord[];
  workflows: string[];
}

export interface TaskRecord {
  id: string;
  caseId: string;
  title: string;
  status: "pending" | "in_progress" | "done";
  assignee?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactRecord {
  id: string;
  caseId: string;
  type: string;
  ref: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface CreateCaseInput {
  title: string;
  tenantId?: string;
  projectId?: string;
  description?: string;
  status?: CaseStatus;
  metadata?: Record<string, unknown>;
}

export interface CreateTaskInput {
  caseId: string;
  title: string;
  assignee?: string;
  metadata?: Record<string, unknown>;
}

export interface AttachArtifactInput {
  caseId: string;
  type: string;
  ref: string;
  metadata?: Record<string, unknown>;
}

export interface CaseQuery {
  tenantId?: string;
  projectId?: string;
}

export class CaseService {
  private readonly cases = new Map<string, CaseRecord>();
  private readonly sessionCases = new Map<string, string>();

  createCase(input: CreateCaseInput): CaseRecord {
    const now = new Date().toISOString();
    const id = `case-${randomUUID()}`;
    const record: CaseRecord = {
      id,
      tenantId: input.tenantId,
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      status: input.status ?? "open",
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
      tasks: [],
      artifacts: [],
      workflows: [],
    };
    this.cases.set(id, record);
    return record;
  }

  listCases(query: CaseQuery = {}): CaseRecord[] {
    return Array.from(this.cases.values()).filter((record) => {
      if (query.tenantId && record.tenantId !== query.tenantId) {
        return false;
      }
      if (query.projectId && record.projectId !== query.projectId) {
        return false;
      }
      return true;
    });
  }

  getCase(caseId: string): CaseRecord | undefined {
    return this.cases.get(caseId);
  }

  attachWorkflow(caseId: string, workflowId: string, tenantId?: string): void {
    const target = this.cases.get(caseId);
    if (!target) {
      throw new Error(`Case ${caseId} not found`);
    }
    if (tenantId && target.tenantId !== tenantId) {
      throw new Error(`Access denied for case ${caseId}`);
    }
    if (!target.workflows.includes(workflowId)) {
      target.workflows.push(workflowId);
      target.updatedAt = new Date().toISOString();
    }
  }

  createTask(input: CreateTaskInput & { tenantId?: string }): TaskRecord {
    const target = this.cases.get(input.caseId);
    if (!target) {
      throw new Error(`Case ${input.caseId} not found`);
    }
    if (input.tenantId && target.tenantId !== input.tenantId) {
      throw new Error(`Access denied for case ${input.caseId}`);
    }
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: `task-${randomUUID()}`,
      caseId: input.caseId,
      title: input.title,
      status: "pending",
      assignee: input.assignee,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };
    target.tasks.push(task);
    target.updatedAt = now;
    return task;
  }

  attachArtifact(input: AttachArtifactInput & { tenantId?: string }): ArtifactRecord {
    const target = this.cases.get(input.caseId);
    if (!target) {
      throw new Error(`Case ${input.caseId} not found`);
    }
    if (input.tenantId && target.tenantId !== input.tenantId) {
      throw new Error(`Access denied for case ${input.caseId}`);
    }
    const now = new Date().toISOString();
    const artifact: ArtifactRecord = {
      id: `artifact-${randomUUID()}`,
      caseId: input.caseId,
      type: input.type,
      ref: input.ref,
      metadata: input.metadata,
      createdAt: now,
    };
    target.artifacts.push(artifact);
    target.updatedAt = now;
    return artifact;
  }

  getOrCreateCaseForSession(sessionId: string, defaults: CreateCaseInput): CaseRecord {
    const existingId = this.sessionCases.get(sessionId);
    if (existingId) {
      const record = this.cases.get(existingId);
      if (record) {
        return record;
      }
      this.sessionCases.delete(sessionId);
    }
    const created = this.createCase(defaults);
    this.sessionCases.set(sessionId, created.id);
    return created;
  }

  resetForTests(): void {
    this.cases.clear();
    this.sessionCases.clear();
  }
}

export const caseService = new CaseService();
