import type {
  Changeset,
  DocumentNode,
  ReferenceNode,
  Snapshot
} from './types.js';
import { emptySnapshot } from './graph.js';

export class ChangesetError extends Error {}

export function cloneSnapshot(snapshot: Snapshot): Snapshot {
  return {
    docs: Object.fromEntries(
      Object.entries(snapshot.docs).map(([id, doc]) => [id, { ...doc }])
    ),
    refs: Object.fromEntries(
      Object.entries(snapshot.refs).map(([id, ref]) => [id, { ...ref }])
    )
  };
}

/**
 * Apply a batch of changes atomically against the base snapshot.
 * Document deletions become tombstones; references pointing at deleted
 * documents are retained as dangling references rather than silently removed.
 */
export function applyChangeset(
  base: Snapshot,
  changes: Changeset
): Snapshot {
  const next = cloneSnapshot(base);

  for (const change of changes.docChanges) {
    const existing = next.docs[change.id];
    switch (change.type) {
      case 'upsert': {
        if (existing) {
          throw new ChangesetError(
            `document ${change.id} already exists; use rename/content edit instead`
          );
        }
        if (!change.path || change.content === undefined) {
          throw new ChangesetError(`upsert ${change.id} requires path and content`);
        }
        const doc: DocumentNode = {
          id: change.id,
          path: change.path,
          content: change.content,
          parserVersion: change.parserVersion ?? 1,
          deleted: false
        };
        next.docs[change.id] = doc;
        break;
      }
      case 'rename': {
        if (!existing) {
          throw new ChangesetError(`cannot rename missing document ${change.id}`);
        }
        if (existing.deleted) {
          throw new ChangesetError(`cannot rename deleted document ${change.id}`);
        }
        if (change.path !== undefined) {
          existing.path = change.path;
        }
        if (change.content !== undefined) {
          existing.content = change.content;
        }
        if (change.parserVersion !== undefined) {
          existing.parserVersion = change.parserVersion;
        }
        break;
      }
      case 'delete': {
        if (!existing) {
          throw new ChangesetError(`cannot delete missing document ${change.id}`);
        }
        existing.deleted = true;
        break;
      }
    }
  }

  for (const change of changes.refChanges) {
    const existing = next.refs[change.id];
    switch (change.type) {
      case 'add': {
        if (existing) {
          throw new ChangesetError(`reference ${change.id} already exists`);
        }
        if (!change.fromDoc || !change.toDoc) {
          throw new ChangesetError(`add reference ${change.id} needs fromDoc/toDoc`);
        }
        const ref: ReferenceNode = {
          id: change.id,
          fromDoc: change.fromDoc,
          toDoc: change.toDoc,
          deleted: false
        };
        next.refs[change.id] = ref;
        break;
      }
      case 'retarget': {
        if (!existing) {
          throw new ChangesetError(`cannot retarget missing reference ${change.id}`);
        }
        if (existing.deleted) {
          throw new ChangesetError(`cannot retarget removed reference ${change.id}`);
        }
        if (change.fromDoc !== undefined) {
          existing.fromDoc = change.fromDoc;
        }
        if (change.toDoc !== undefined) {
          existing.toDoc = change.toDoc;
        }
        break;
      }
      case 'remove': {
        if (!existing) {
          throw new ChangesetError(`cannot remove missing reference ${change.id}`);
        }
        existing.deleted = true;
        break;
      }
    }
  }

  return next;
}

export function isRefDangling(snapshot: Snapshot, ref: ReferenceNode): boolean {
  if (ref.deleted) {
    return false;
  }
  const source = snapshot.docs[ref.fromDoc];
  const target = snapshot.docs[ref.toDoc];
  return (
    !source || source.deleted || !target || target.deleted
  );
}

export function snapshotFromDocs(docs: DocumentNode[]): Snapshot {
  const snapshot = emptySnapshot();
  for (const doc of docs) {
    snapshot.docs[doc.id] = { ...doc };
  }
  return snapshot;
}
