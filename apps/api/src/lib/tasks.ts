import { type Db, pool } from '../db/pool.js';

/**
 * Staff follow-up tasks. A dedupe key makes task creation idempotent, so
 * scheduled jobs can run repeatedly without creating duplicates.
 */
export async function createTask(
  t: {
    kind: string;
    title: string;
    description?: string;
    entityType?: string;
    entityId?: string;
    assigneeId?: string | null;
    assigneeRole?: string | null;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
    dueAt?: Date | string | null;
    dedupeKey?: string;
  },
  db: Db = pool,
): Promise<boolean> {
  const res = await db.query(
    `insert into tasks (kind, title, description, entity_type, entity_id, assignee_id, assignee_role, priority, due_at, dedupe_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (dedupe_key) do nothing`,
    [
      t.kind, t.title, t.description ?? null, t.entityType ?? null, t.entityId ?? null,
      t.assigneeId ?? null, t.assigneeRole ?? null, t.priority ?? 'normal', t.dueAt ?? null, t.dedupeKey ?? null,
    ],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function closeTasks(entityType: string, entityId: string, kind: string, userId: string | null, db: Db = pool) {
  await db.query(
    `update tasks set status = 'done', completed_by = $4, completed_at = now()
      where entity_type = $1 and entity_id = $2 and kind = $3 and status = 'open'`,
    [entityType, entityId, kind, userId],
  );
}
