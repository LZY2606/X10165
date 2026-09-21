import { describe, expect, it } from "vitest";
import { MemoryPersistence } from "../engine/persistence";
import { SimulatorStore } from "../engine/store";
import type { ChangeOp } from "../engine/types";
import { buildGraph } from "../engine/graph";
import { tokenId, VIEWS, docId, rankId } from "../engine/ids";
import { contentHashKey } from "../engine/ids";

function setup(): SimulatorStore {
  return new SimulatorStore(new MemoryPersistence(), () => 1000);
}

function tokenNode(store: SimulatorStore, revisionId: string, path: string): string {
  const revision = store.revision(revisionId)!;
  const doc = revision.snapshot.docs[path]!;
  return tokenId(contentHashKey(doc.content, doc.parserVersion), doc.parserVersion);
}

describe("增量索引失效模拟", () => {
  it("改名复用：内容派生复用、路径敏感派生失效", () => {
    const store = setup();
    const before = store.head().id;
    const tokenBefore = tokenNode(store, before, "docs/intro.md");

    const plan = store.submitChangeSet("重命名 intro", {
      description: "重命名 intro",
      ops: [{ type: "renameDoc", path: "docs/intro.md", newPath: "docs/intro-renamed.md" }],
    });
    const cs = store.getState().changeSets[plan.changeSetId]!;
    store.runToCompletion();
    const after = store.head().id;

    expect(after).toBe(cs.targetRevisionId);
    expect(plan.status).toBe("published");
    expect(plan.analysis.reused).toContain(tokenBefore);
    expect(plan.analysis.reused).toContain(VIEWS.tokenFingerprint);
    expect(plan.analysis.affected.map((item) => item.nodeId)).toContain(VIEWS.tokenIndex);
    expect(plan.analysis.affected.map((item) => item.nodeId)).toContain(rankId("docs/intro-renamed.md"));
    expect(plan.analysis.origins.some((o) => o.kind === "doc-rename-out")).toBe(true);
    expect(plan.analysis.origins.some((o) => o.kind === "doc-rename-in")).toBe(true);

    const routes = plan.analysis.affected.find(
      (item) => item.nodeId === VIEWS.tokenIndex,
    )!.routes;
    expect(routes[0]!.originId).toBe(docId("docs/intro-renamed.md"));
    expect(routes.some((route) => route.hops.some((hop) => hop.type === "path"))).toBe(true);
  });

  it("路径敏感节点：引用节点跟随文档路径", () => {
    const store = setup();
    const plan = store.submitChangeSet("移动 api", {
      description: "移动 api",
      ops: [{ type: "renameDoc", path: "docs/api.md", newPath: "docs/reference/api.md" }],
    });
    store.runToCompletion();
    const affectedIds = plan.analysis.affected.map((item) => item.nodeId);
    expect(affectedIds).toContain("ref:r-api-intro");
    expect(affectedIds).toContain("ref:r-guide-api");
    expect(affectedIds).toContain(VIEWS.refGraph);
    const refRoute = plan.analysis.affected.find((item) => item.nodeId === "ref:r-guide-api")!.routes[0]!;
    expect(refRoute.hops.every((hop) => hop.type === "path")).toBe(true);
  });

  it("解析器升级：仅声明依赖该版本的 token 及其下游失效", () => {
    const store = setup();
    const before = store.head().id;
    const guideTokenBefore = tokenNode(store, before, "docs/guide.md");
    const introTokenBefore = tokenNode(store, before, "docs/intro.md");

    const plan0 = store.submitChangeSet("升级 guide 解析器", {
      description: "升级 guide 解析器",
      ops: [{
        type: "upsertDoc",
        path: "docs/guide.md",
        content: store.head().snapshot.docs["docs/guide.md"]!.content,
        parserVersion: "v2",
      }],
    });
    const plan = plan0;
    store.runToCompletion();
    const guideTokenAfter = tokenNode(store, plan.targetRevisionId, "docs/guide.md");

    expect(guideTokenAfter).not.toBe(guideTokenBefore);
    expect(plan.analysis.retired).toContain(guideTokenBefore);
    expect(plan.analysis.affected.map((item) => item.nodeId)).not.toContain(introTokenBefore);
    expect(plan.analysis.origins.some((o) => o.kind === "doc-parser")).toBe(true);
    expect(plan.analysis.affected.map((item) => item.nodeId)).toContain(VIEWS.tokenFingerprint);
    expect(plan.analysis.affected.map((item) => item.nodeId)).toContain(VIEWS.tokenIndex);
  });

  it("删除墓碑：墓碑保留、旧引用悬挂且不静默消失", () => {
    const store = setup();
    const plan = store.submitChangeSet("删除 api", {
      description: "删除 api",
      ops: [{ type: "deleteDoc", path: "docs/api.md" }],
    });
    store.runToCompletion();
    const revision = store.revision(plan.targetRevisionId)!;

    expect(revision.snapshot.tombstones["docs/api.md"]).toBeDefined();
    expect(revision.snapshot.refs["r-guide-api"]).toBeDefined();
    expect(revision.summary?.danglingRefs).toBe(2);
    const refGraphValue = store.values(revision.id)[VIEWS.refGraph]!;
    const dangling = refGraphValue.graphEdges!.filter((edge) => edge.dangling).map((edge) => edge.refId);
    expect(dangling).toContain("r-guide-api");
    expect(dangling).toContain("r-api-intro");
    expect(plan.analysis.affected.map((item) => item.nodeId)).toContain("tomb:docs/api.md");
  });

  it("快照隔离：新 revision 到达时，旧计划仍基于原快照完成并标记过时", () => {
    const store = setup();
    const firstPlan0 = store.submitChangeSet("第一批：改 intro 内容", {
      description: "第一批",
      ops: [{
        type: "upsertDoc",
        path: "docs/intro.md",
        content: "alpha alpha fresh introduction",
        parserVersion: "v1",
      }],
    });
    const firstPlan = firstPlan0;
    const first = store.getState().changeSets[firstPlan.changeSetId]!;
    expect(firstPlan.baseRevisionId).toBe("rev-000");

    store.advancePlan(firstPlan.id);
    expect(firstPlan.completedPhases).toEqual(["prepare", "invalidate"]);

    const secondPlan0 = store.submitChangeSet("第二批：改 guide 内容", {
      description: "第二批",
      ops: [{
        type: "upsertDoc",
        path: "docs/guide.md",
        content: "beta gamma totally changed guide",
        parserVersion: "v1",
      }],
    });

    expect(firstPlan.outdated).toBe(true);
    expect(firstPlan.baseRevisionId).toBe("rev-000");
    const secondPlan = secondPlan0;
    const second = store.getState().changeSets[secondPlan.changeSetId]!;
    expect(store.activePlan()!.id).not.toBe(firstPlan.id);

    store.runToCompletion(firstPlan.id);
    expect(firstPlan.status).toBe("published");
    expect(store.revision(first.targetRevisionId)!.snapshot.docs["docs/guide.md"]!.content)
      .toBe("beta gamma delta guide index");
    expect(store.head().id).toBe(first.targetRevisionId);

    store.runToCompletion(secondPlan.id);
    expect(store.revision(second.targetRevisionId)!.parentId).toBe("rev-000");
    expect(store.head().id).toBe(second.targetRevisionId);
    expect(firstPlan.analysis.affected.some((item) => item.nodeId.includes("guide"))).toBe(false);
  });

  it("环形固定点：稳定顺序迭代直至收敛", () => {
    const store = setup();
    const plan = store.submitChangeSet("增加一条环引用", {
      description: "增加环引用",
      ops: [{ type: "upsertRef", refId: "r-intro-api", from: "docs/intro.md", to: "docs/api.md", label: "直达 API" }],
    });
    store.runToCompletion();
    const convergeEvent = plan.events.filter((event) => event.type === "fixedpoint-converged");
    expect(convergeEvent.length).toBe(1);
    const summary = store.head().summary!;
    expect(summary.rankConverged).toBe(true);
    expect(summary.rankTop.map(([path]) => path)).toEqual([
      "docs/api.md",
      "docs/guide.md",
      "docs/intro.md",
    ]);
    const group = plan.analysis.fixedPointGroup;
    expect(group).toEqual([...group].sort());
  });

  it("预算耗尽：保存中间状态与诊断，计划失败且不发布", () => {
    const store = setup();
    store.setFixedPointBudget(1);
    const beforeHead = store.head().id;
    const plan = store.submitChangeSet("制造预算耗尽", {
      description: "制造预算耗尽",
      ops: [
        { type: "upsertRef", refId: "r-x", from: "docs/intro.md", to: "docs/api.md" },
        { type: "upsertRef", refId: "r-y", from: "docs/api.md", to: "docs/guide.md" },
      ],
    });
    store.runToCompletion();
    expect(plan.status).toBe("failed");
    expect(plan.diagnostics?.converged).toBe(false);
    expect(plan.diagnostics?.iterations).toBe(1);
    expect(plan.intermediateScores).toBeDefined();
    expect(plan.events.some((event) => event.type === "fixedpoint-budget-exhausted")).toBe(true);
    expect(store.revision(plan.targetRevisionId)).toBeUndefined();
    expect(store.head().id).toBe(beforeHead);
    expect(plan.completedPhases).toEqual(["prepare", "invalidate", "recompute"]);

    const retried = store.retryFailedPlan(plan.id, 100);
    store.runToCompletion(retried.id);
    expect(retried.status).toBe("published");
    expect(store.head().id).toBe(plan.targetRevisionId);
  });

  it("阶段恢复：崩溃后从最后一个完整阶段继续，不重复完成阶段", () => {
    const adapter = new MemoryPersistence();
    const store = new SimulatorStore(adapter, () => 1000);
    const plan0 = store.submitChangeSet("恢复实验", {
      description: "恢复实验",
      ops: [{ type: "upsertDoc", path: "docs/recovery.md", content: "recover alpha", parserVersion: "v1" }],
    });
    const cs = store.getState().changeSets[plan0.changeSetId]!;
    void cs;
    store.advancePlan();
    expect(store.activePlan()!.completedPhases).toEqual(["prepare", "invalidate"]);

    store.crashBeforeNextSave();
    expect(() => store.advancePlan()).toThrow(/崩溃/);

    const resumed = new SimulatorStore(adapter, () => 1000);
    const plan = resumed.activePlan();
    expect(plan!.id).not.toBeNull();
    expect(plan!.completedPhases).toEqual(["prepare", "invalidate"]);
    expect(plan!.nextPhase).toBe("recompute");
    expect(plan!.changeSetId).toBe(cs.id);
    resumed.runToCompletion();
    expect(resumed.head().snapshot.docs["docs/recovery.md"]).toBeDefined();
    expect(resumed.activePlan()).toBeNull();
    const invalidateCompletions = resumed
      .plan(plan!.id)
      .events.filter((event) => event.phase === "invalidate" && event.type === "phase-complete");
    expect(invalidateCompletions.length).toBe(1);
  });

  it("导出导入后计划顺序与摘要一致", () => {
    const store = setup();
    const plan = store.submitChangeSet("导出实验", {
      description: "导出实验",
      ops: [{ type: "deleteDoc", path: "docs/guide.md" }],
    });
    store.runToCompletion();
    const bundle = store.exportBundle();
    const imported = setup();
    imported.importBundle(bundle);

    expect(imported.head().summary).toEqual(store.head().summary);
    const importedPlan = imported.plan(plan.id);
    expect(importedPlan.analysis.order).toEqual(plan.analysis.order);
    expect(importedPlan.status).toBe(plan.status);
    expect(Object.keys(imported.getState().revisions).sort()).toEqual(
      Object.keys(store.getState().revisions).sort(),
    );
  });

  it("重算顺序遵循依赖层级，且可给出源到派生项的路径", () => {
    const store = setup();
    const ops: ChangeOp[] = [{
      type: "upsertDoc",
      path: "docs/intro.md",
      content: "brand new alpha beta content here",
      parserVersion: "v1",
    }];
    const plan = store.submitChangeSet("内容修改", { description: "内容修改", ops });
    store.runToCompletion();
    const order = plan.analysis.order;
    const tokenIndexPos = order.indexOf(VIEWS.tokenIndex);
    const rankViewPos = order.indexOf(VIEWS.rank);
    const tokenPos = order.findIndex((id) => id.startsWith("token:"));
    expect(tokenPos).toBeGreaterThanOrEqual(0);
    expect(tokenIndexPos).toBeGreaterThan(tokenPos);
    expect(rankViewPos).toBeGreaterThanOrEqual(0);
    const fingerprint = plan.analysis.affected.find((item) => item.nodeId === VIEWS.tokenFingerprint)!;
    expect(fingerprint.routes[0]!.hops.length).toBeGreaterThan(0);
    expect(fingerprint.routes[0]!.hops.at(-1)!.to).toBe(VIEWS.tokenFingerprint);
  });
});
