import type { ChangeSet, ChangeOp, Snapshot } from "./types";

export function emptySnapshot(): Snapshot {
  return { docs: {}, refs: {}, tombstones: {} };
}

export function cloneSnapshot(snapshot: Snapshot): Snapshot {
  return {
    docs: Object.fromEntries(
      Object.entries(snapshot.docs).map(([path, doc]) => [path, { ...doc }]),
    ),
    refs: Object.fromEntries(
      Object.entries(snapshot.refs).map(([id, ref]) => [id, { ...ref }]),
    ),
    tombstones: Object.fromEntries(
      Object.entries(snapshot.tombstones).map(([path, t]) => [path, { ...t }]),
    ),
  };
}

export class ChangeRejectedError extends Error {}

function applyOp(snapshot: Snapshot, op: ChangeOp, at: number): void {
  switch (op.type) {
    case "upsertDoc": {
      if (!op.path) {
        throw new ChangeRejectedError("upsertDoc 缺少 path");
      }
      snapshot.docs[op.path] = {
        path: op.path,
        content: op.content ?? "",
        parserVersion: op.parserVersion ?? "v1",
      };
      delete snapshot.tombstones[op.path];
      return;
    }
    case "deleteDoc": {
      if (!op.path) {
        throw new ChangeRejectedError("deleteDoc 缺少 path");
      }
      if (!snapshot.docs[op.path]) {
        throw new ChangeRejectedError(`文档不存在：${op.path}`);
      }
      delete snapshot.docs[op.path];
      snapshot.tombstones[op.path] = {
        path: op.path,
        at,
        reason: "deleteDoc",
      };
      return;
    }
    case "renameDoc": {
      if (!op.path || !op.newPath) {
        throw new ChangeRejectedError("renameDoc 缺少 path/newPath");
      }
      const doc = snapshot.docs[op.path];
      if (!doc) {
        throw new ChangeRejectedError(`待改名文档不存在：${op.path}`);
      }
      if (op.path !== op.newPath && snapshot.docs[op.newPath]) {
        throw new ChangeRejectedError(`目标路径已存在：${op.newPath}`);
      }
      if (op.content !== undefined) {
        doc.content = op.content;
      }
      if (op.parserVersion !== undefined) {
        doc.parserVersion = op.parserVersion;
      }
      delete snapshot.docs[op.path];
      doc.path = op.newPath;
      snapshot.docs[op.newPath] = doc;
      delete snapshot.tombstones[op.newPath];
      return;
    }
    case "upsertRef": {
      if (!op.refId) {
        throw new ChangeRejectedError("upsertRef 缺少 refId");
      }
      snapshot.refs[op.refId] = {
        id: op.refId,
        from: op.from ?? "",
        to: op.to ?? "",
        label: op.label,
      };
      return;
    }
    case "deleteRef": {
      if (!op.refId) {
        throw new ChangeRejectedError("deleteRef 缺少 refId");
      }
      delete snapshot.refs[op.refId];
      return;
    }
  }
}

export function applyChangeSet(base: Snapshot, changeSet: ChangeSet, at: number): Snapshot {
  const next = cloneSnapshot(base);
  for (const op of changeSet.ops) {
    applyOp(next, op, at);
  }
  return next;
}
