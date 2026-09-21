import { it } from "vitest";
import { MemoryPersistence } from "../engine/persistence";
import { SimulatorStore } from "../engine/store";
it("dbg", () => {
  const store = new SimulatorStore(new MemoryPersistence(), () => 1000);
  const plan = store.submitChangeSet("x", {
    description: "x",
    ops: [{ type: "renameDoc", path: "docs/intro.md", newPath: "docs/intro-renamed.md" }],
  });
  const a = plan.analysis;
  console.log("origins", a.origins.map((o) => o.kind + ":" + o.nodeId));
  console.log("added", a.added);
  console.log("retired", a.retired);
  console.log("reused", a.reused);
  console.log("affected", a.affected.map((x) => x.nodeId));
  console.log("order", a.order);
});
