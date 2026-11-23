import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { activityLogsTable as activity, authLogsTable as authentication } from '../db/schema.js';

export function recordActivity(db: Pick<Database['db'], 'insert'>, event: typeof activity.$inferInsert) {
  return db.insert(activity).values(event);
}

export const auditStreams = ['activity', 'authentication'] as const;
type Stream = typeof auditStreams[number];
const attributedActions = ['auth.login_succeeded', 'auth.refresh_succeeded', 'auth.logout', 'auth.device_sessions_revoked'];
const authActor = sql<string | null>`case when ${authentication.action} in (${sql.join(attributedActions.map((action) => sql`${action}`), sql`, `)})
  then ${authentication.userId} else null end`;
const authTargetType = sql<string | null>`coalesce(${authentication.targetType}, case when ${authentication.userId} is not null then 'user' end)`;
const authTargetId = sql<string | null>`coalesce(${authentication.targetId}, ${authentication.userId}::text)`;

export type AuditQuery = { stream: Stream; actorUserId?: string; targetType?: string; targetId?: string; action?: string;
  fromDate?: string; toDate?: string; after?: string; limit: number };

export class AuditQueryError extends Error {}

function cursorOf(stream: Stream, timestamp: string, id: string) {
  return Buffer.from(`${stream}/${timestamp}/${id}`).toString('base64url');
}

function parseCursor(value: string, stream: Stream) {
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  const [source, timestamp, id, extra] = decoded.split('/');
  if (source !== stream || !timestamp || !id || extra !== undefined || cursorOf(stream, timestamp, id) !== value ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(timestamp) ||
      !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) throw new AuditQueryError('Invalid audit cursor');
  const millis = `${timestamp.slice(0, 23)}Z`;
  const date = new Date(millis);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== millis || timestamp.startsWith('0000')) {
    throw new AuditQueryError('Invalid audit cursor');
  }
  return { timestamp, id };
}

export async function listAuditEvents(db: Database['db'], query: AuditQuery) {
  if (query.fromDate && query.toDate && query.fromDate > query.toDate) throw new AuditQueryError('Invalid date range');
  const cursor = query.after ? parseCursor(query.after, query.stream) : undefined;
  const isActivity = query.stream === 'activity';
  const table = isActivity ? activity : authentication;
  const actor = isActivity ? activity.actorUserId : authActor;
  const targetType = isActivity ? activity.entityType : authTargetType;
  const targetId = isActivity ? activity.entityId : authTargetId;
  // Retain microseconds through the API so equal-millisecond records paginate without gaps.
  const timestamp = sql<string>`to_char(${table.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const items = await db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '4s'`);
    return tx.select({ id: table.id, actorUserId: actor, targetType, targetId, action: table.action, timestamp })
      .from(table).where(and(
        query.actorUserId ? sql`${actor} = ${query.actorUserId}::uuid` : undefined,
        query.targetType ? sql`${targetType} = ${query.targetType}` : undefined,
        query.targetId ? sql`${targetId} = ${query.targetId}` : undefined,
        query.action ? eq(table.action, query.action) : undefined,
        query.fromDate ? gte(table.createdAt, new Date(`${query.fromDate}T00:00:00Z`)) : undefined,
        query.toDate ? sql`${table.createdAt} < ${`${query.toDate}T00:00:00Z`}::timestamptz + interval '24 hours'` : undefined,
        cursor ? sql`(${table.createdAt}, ${table.id}) < (${cursor.timestamp}::timestamptz, ${cursor.id}::uuid)` : undefined,
      )).orderBy(desc(table.createdAt), desc(table.id)).limit(query.limit + 1);
  }, { accessMode: 'read only' });
  const limited = items.slice(0, query.limit);
  const last = limited.at(-1);
  return { stream: query.stream, items: limited, nextAfter: items.length > query.limit && last
    ? cursorOf(query.stream, last.timestamp, last.id) : null };
}
