import type { Pool } from "pg";

import { getPostgresPool } from "../database/Postgres.js";
import type { Workflow } from "./WorkflowEngine.js";

type WorkflowFilter = { tenantId?: string; projectId?: string };

type StoredMapping = { workflowId: string; planId: string; tenantId?: string };

export class WorkflowRepository {
  private readonly pool: Pool | null;
  private readonly workflows = new Map<string, Workflow>();
  private readonly workflowToPlan = new Map<string, StoredMapping>();
  private readonly planToWorkflow = new Map<string, StoredMapping>();

  constructor(pool: Pool | null = getPostgresPool()) {
    this.pool = pool ?? null;
  }

  async save(workflow: Workflow): Promise<Workflow> {
    if (!this.pool) {
      this.workflows.set(workflow.id, workflow);
      return workflow;
    }

    const result = await this.pool.query<Workflow>(
      `INSERT INTO workflows (id, tenant_id, project_id, name, plan, nodes, subject, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       ON CONFLICT (id)
       DO UPDATE SET name = EXCLUDED.name,
                     tenant_id = EXCLUDED.tenant_id,
                     project_id = EXCLUDED.project_id,
                     plan = EXCLUDED.plan,
                     nodes = EXCLUDED.nodes,
                     subject = EXCLUDED.subject,
                     updated_at = NOW()
       RETURNING id, tenant_id as "tenantId", project_id as "projectId", name, plan, nodes, subject,
                 to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
                 to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "updatedAt"`,
      [
        workflow.id,
        workflow.tenantId ?? null,
        workflow.projectId ?? null,
        workflow.name,
        workflow.plan ?? null,
        workflow.nodes,
        workflow.subject ?? null,
        workflow.createdAt,
      ],
    );

    return result.rows[0];
  }

  async get(workflowId: string): Promise<Workflow | undefined> {
    if (!this.pool) {
      return this.workflows.get(workflowId);
    }

    const result = await this.pool.query<Workflow>(
      `SELECT id, tenant_id as "tenantId", project_id as "projectId", name, plan, nodes, subject,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "updatedAt"
         FROM workflows
        WHERE id = $1`,
      [workflowId],
    );

    return result.rows[0];
  }

  async list(filter?: WorkflowFilter): Promise<Workflow[]> {
    if (!this.pool) {
      return Array.from(this.workflows.values()).filter((workflow) => {
        if (filter?.tenantId && (!workflow.tenantId || workflow.tenantId !== filter.tenantId)) {
          return false;
        }
        if (filter?.projectId && workflow.projectId !== filter.projectId) {
          return false;
        }
        return true;
      });
    }

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter?.tenantId) {
      conditions.push(`tenant_id = $${values.length + 1}`);
      values.push(filter.tenantId);
    }
    if (filter?.projectId) {
      conditions.push(`project_id = $${values.length + 1}`);
      values.push(filter.projectId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await this.pool.query<Workflow>(
      `SELECT id, tenant_id as "tenantId", project_id as "projectId", name, plan, nodes, subject,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "updatedAt"
         FROM workflows
         ${whereClause}
        ORDER BY updated_at DESC`,
      values,
    );

    return result.rows;
  }

  async rememberPlanMapping(mapping: StoredMapping): Promise<void> {
    if (!this.pool) {
      this.workflowToPlan.set(mapping.workflowId, mapping);
      this.planToWorkflow.set(mapping.planId, mapping);
      return;
    }

    await this.pool.query(
      `INSERT INTO workflow_plans (workflow_id, plan_id, tenant_id, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (workflow_id)
       DO UPDATE SET plan_id = EXCLUDED.plan_id,
                     tenant_id = EXCLUDED.tenant_id`,
      [mapping.workflowId, mapping.planId, mapping.tenantId ?? null],
    );
  }

  async getPlanId(workflowId: string): Promise<string | undefined> {
    if (!this.pool) {
      return this.workflowToPlan.get(workflowId)?.planId;
    }

    const result = await this.pool.query<{ planId: string }>(
      `SELECT plan_id as "planId" FROM workflow_plans WHERE workflow_id = $1`,
      [workflowId],
    );

    return result.rows[0]?.planId;
  }

  async getWorkflowIdForPlan(planId: string): Promise<string | undefined> {
    if (!this.pool) {
      return this.planToWorkflow.get(planId)?.workflowId;
    }

    const result = await this.pool.query<{ workflowId: string }>(
      `SELECT workflow_id as "workflowId" FROM workflow_plans WHERE plan_id = $1`,
      [planId],
    );

    return result.rows[0]?.workflowId;
  }

  reset(): void {
    this.workflows.clear();
    this.workflowToPlan.clear();
    this.planToWorkflow.clear();
  }
}

let repositoryInstance: WorkflowRepository | null = null;

export function getWorkflowRepository(): WorkflowRepository {
  if (!repositoryInstance) {
    repositoryInstance = new WorkflowRepository();
  }
  return repositoryInstance;
}

export function resetWorkflowRepository(): void {
  repositoryInstance?.reset();
  repositoryInstance = null;
}
