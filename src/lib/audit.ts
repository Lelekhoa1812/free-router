import type { Db } from "mongodb";

export interface AuditEvent {
  action: string;
  actorEmail: string;
  outcome: string;
  targetId?: string;
  targetName?: string;
  detail?: Record<string, string | number | boolean>;
}

const retentionMs = 30 * 86400_000;

/**
 * Record an administrative mutation. Callers pass no secrets: names, ids and
 * outcomes only. Failures are swallowed so an audit outage cannot fail the
 * operation it observes.
 */
export async function recordAudit(db: Db, event: AuditEvent) {
  try {
    const createdAt = new Date();
    await db.collection("audit_events").insertOne({ ...event, createdAt, expiresAt: new Date(createdAt.getTime() + retentionMs) });
  } catch {
    // Audit is best-effort; the mutation itself already succeeded.
  }
}
