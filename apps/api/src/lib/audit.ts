import { type Db, pool, query } from '../db/pool.js';
import { sha256 } from './crypto.js';

/**
 * Append to the tamper-evident audit log (FR-ADM-12). The hash chain is
 * computed by a database trigger so no code path can skip it.
 */
export async function audit(
  entry: {
    actorId?: string | null;
    action: string;
    entityType?: string;
    entityId?: string | null;
    ip?: string | null;
    details?: Record<string, unknown>;
  },
  db: Db = pool,
) {
  await db.query(
    `insert into audit_log (actor_id, action, entity_type, entity_id, ip, details)
     values ($1, $2, $3, $4, $5, $6)`,
    [entry.actorId ?? null, entry.action, entry.entityType ?? null, entry.entityId ?? null, entry.ip ?? null, entry.details ?? {}],
  );
}

/** Recompute the chain and report the first row whose hash does not match. */
export async function verifyAuditChain(): Promise<{ ok: boolean; checked: number; brokenAt?: number }> {
  const rows = await query<{
    id: number; actor_id: string | null; action: string; entity_type: string | null; entity_id: string | null;
    details: unknown; prev_hash: string; hash: string; ts: string;
  }>(
    `select id, actor_id, action, entity_type, entity_id, details::text as details, prev_hash, hash,
            to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as ts
       from audit_log order by id`,
  );
  let prev = '0'.repeat(64);
  for (const r of rows) {
    const expected = sha256(
      [prev, r.actor_id ?? '', r.action, r.entity_type ?? '', r.entity_id ?? '', r.details, r.ts].join('|'),
    );
    if (r.prev_hash !== prev || r.hash !== expected) return { ok: false, checked: rows.length, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true, checked: rows.length };
}

/** Record a before/after diff for profile changes (FR-ENT-05). */
export async function recordChanges(
  entityType: string,
  entityId: string,
  changedBy: string | null,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  db: Db = pool,
) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) changes[key] = { from: a ?? null, to: b ?? null };
  }
  if (Object.keys(changes).length === 0) return;
  await db.query(
    'insert into change_history (entity_type, entity_id, changed_by, changes) values ($1, $2, $3, $4)',
    [entityType, entityId, changedBy, changes],
  );
}
