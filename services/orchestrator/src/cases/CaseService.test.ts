import { describe, expect, it, beforeEach } from "vitest";

import { CaseService, type CaseStatus, resetCaseServiceForTests } from "./CaseService.js";

const tenantId = "tenant-123";

function createService(): CaseService {
  return new CaseService(null);
}

describe("CaseService (in-memory)", () => {
  beforeEach(() => {
    resetCaseServiceForTests();
  });

  it("creates and lists cases scoped to tenant", async () => {
    const service = createService();
    const created = await service.createCase({ tenantId, title: "Investigate bug" });
    await service.createCase({ tenantId: "other", title: "Skip me" });

    const cases = await service.listCases({ tenantId });
    expect(cases).toHaveLength(1);
    expect(cases[0].id).toBe(created.id);
    expect(cases[0].status).toBe("open");
  });

  it("creates tasks and artifacts for a case", async () => {
    const service = createService();
    const created = await service.createCase({ tenantId, title: "Add feature" });

    const task = await service.createTask({ caseId: created.id, title: "Design" });
    const artifact = await service.attachArtifact({
      caseId: created.id,
      type: "document",
      ref: "doc://design",
    });

    const tasks = await service.listTasks(created.id);
    const artifacts = await service.listArtifacts(created.id);

    expect(tasks.map((t) => t.id)).toContain(task.id);
    expect(artifacts.map((a) => a.id)).toContain(artifact.id);
  });

  it("reuses the same case for a session", async () => {
    const service = createService();
    const sessionId = "a39bbf3a-20ea-4c44-995f-96217b514f55";

    const first = await service.getOrCreateCaseForSession(sessionId, tenantId, "project-1");
    const second = await service.getOrCreateCaseForSession(sessionId, tenantId, "project-1");

    expect(second.id).toBe(first.id);
    expect(second.status).toBe<CaseStatus>("active");
  });
});
