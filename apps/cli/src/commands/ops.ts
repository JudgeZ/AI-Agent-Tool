import { getJson, resolveGatewayConfig } from "../gateway";
import { printLine } from "../output";

interface CaseRecord {
  id: string;
  title: string;
  status: string;
  projectId?: string;
  tenantId?: string;
}

interface WorkflowRecord {
  id: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
}

export async function listCases(): Promise<void> {
  const config = resolveGatewayConfig();
  const { cases } = await getJson<{ cases: CaseRecord[] }>("cases", config);
  if (!cases.length) {
    printLine("No cases found.");
    return;
  }
  for (const item of cases) {
    const projectText = item.projectId ? `project=${item.projectId}` : "";
    printLine(`• ${item.title} (${item.id}) status=${item.status} ${projectText}`.trim());
  }
}

export async function listWorkflows(): Promise<void> {
  const config = resolveGatewayConfig();
  const { workflows } = await getJson<{ workflows: WorkflowRecord[] }>("workflows", config);
  if (!workflows.length) {
    printLine("No workflows found.");
    return;
  }
  for (const workflow of workflows) {
    const timestamps = [
      workflow.startedAt ? `started=${workflow.startedAt}` : undefined,
      workflow.completedAt ? `completed=${workflow.completedAt}` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    printLine(
      `• workflow ${workflow.id} status=${workflow.status}${timestamps ? ` ${timestamps}` : ""}`,
    );
  }
}

export async function runOps(mode: "cases" | "workflows" | "all" = "all"): Promise<void> {
  if (mode === "cases") {
    await listCases();
    return;
  }
  if (mode === "workflows") {
    await listWorkflows();
    return;
  }
  await listCases();
  await listWorkflows();
}
