import { beforeEach, describe, expect, it } from "vitest";

import { caseService, type CaseRecord } from "./CaseService.js";

describe("CaseService", () => {
  beforeEach(() => {
    caseService.resetForTests();
  });

  it("creates and lists cases scoped by tenant and project", () => {
    const created = caseService.createCase({
      title: "Investigate flaky tests",
      tenantId: "tenant-a",
      projectId: "proj-1",
    });

    const scoped = caseService.listCases({ tenantId: "tenant-a", projectId: "proj-1" });
    expect(scoped).toContainEqual(created);

    const otherTenant = caseService.listCases({ tenantId: "tenant-b" });
    expect(otherTenant).toHaveLength(0);
  });

  it("attaches tasks, artifacts, and workflows to a case", () => {
    const target = caseService.createCase({
      title: "Database upgrade",
      tenantId: "tenant-a",
      projectId: "proj-2",
    });

    const task = caseService.createTask({ caseId: target.id, title: "Plan downtime" });
    const artifact = caseService.attachArtifact({
      caseId: target.id,
      type: "doc",
      ref: "runbook-123",
    });
    caseService.attachWorkflow(target.id, "wf-1");

    const updated = caseService.getCase(target.id);
    expect(updated).toBeDefined();
    expect(updated!.tasks).toContainEqual(task);
    expect(updated!.artifacts).toContainEqual(artifact);
    expect(updated!.workflows).toContain("wf-1");
  });

  it("maps sessions to cases on demand", () => {
    const sessionCase = caseService.getOrCreateCaseForSession("session-1", {
      title: "Session case",
      tenantId: "tenant-a",
    });

    const fetched = caseService.getOrCreateCaseForSession("session-1", {
      title: "ignored",
    });
    expect(fetched.id).toEqual(sessionCase.id);
  });
});
