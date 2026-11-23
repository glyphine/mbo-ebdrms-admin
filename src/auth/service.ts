import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { authLogsTable, authSessionsTable, refreshTokensTable, userDevicesTable, usersTable } from '../db/schema.js';
import { requestDeviceEnrollment, verifyApprovedDevice } from '../devices/service.js';
import { verifyPassword } from './password.js';

type AuthDatabase = Pick<Database['db'], 'select' | 'insert' | 'update' | 'transaction'>;
type PasswordInput = { email: string; password: string };
type DeviceProof = { deviceId: string; deviceCredential: string };
export type SessionIdentity = { userId: string; deviceId: string; sessionId: string };

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const newRefreshToken = () => randomBytes(32).toString('base64url');
const sessionActive = and(isNull(authSessionsTable.revokedAt), sql`${authSessionsTable.expiresAt} > clock_timestamp()`);

async function passwordIdentity(db: AuthDatabase, input: PasswordInput) {
  const [user] = await db.select({ id: usersTable.id, passwordHash: usersTable.passwordHash })
    .from(usersTable).where(and(eq(usersTable.email, input.email), eq(usersTable.isActive, true)));
  return await verifyPassword(input.password, user?.passwordHash) ? user : undefined;
}

async function lockActiveUser(db: AuthDatabase, id: string, passwordHash?: string) {
  const [user] = await db.select({ id: usersTable.id }).from(usersTable).where(and(
    eq(usersTable.id, id), eq(usersTable.isActive, true),
    passwordHash === undefined ? undefined : eq(usersTable.passwordHash, passwordHash),
  )).for('share');
  return !!user;
}

async function audit(db: AuthDatabase, action: string, userId?: string, target?: { targetType: string; targetId: string }) {
  await db.insert(authLogsTable).values({ action, userId, ...target });
}

export async function enrollDevice(db: AuthDatabase, input: PasswordInput & { label: string }) {
  const user = await passwordIdentity(db, input);
  const enrollment = user && await db.transaction(async (tx) => {
    if (!await lockActiveUser(tx, user.id, user.passwordHash)) return undefined;
    return requestDeviceEnrollment(tx, user.id, input.label);
  });
  if (!enrollment) await audit(db, 'device.enrollment_denied', user?.id);
  return enrollment;
}

export async function login(db: AuthDatabase, input: PasswordInput & DeviceProof) {
  const user = await passwordIdentity(db, input);
  const result = user && await db.transaction(async (tx) => {
    const target = { userId: user.id, deviceId: input.deviceId };
    if (!await lockActiveUser(tx, user.id, user.passwordHash) ||
        !await verifyApprovedDevice(tx, target, input.deviceCredential)) return undefined;

    const [session] = await tx.insert(authSessionsTable).values({
      ...target, expiresAt: sql`now() + interval '30 days'`,
    }).returning({ id: authSessionsTable.id, expiresAt: authSessionsTable.expiresAt });
    if (!session) throw new Error('Session insert returned no row');
    const refreshToken = newRefreshToken();
    await tx.insert(refreshTokensTable).values({
      sessionId: session.id, tokenHash: digest(refreshToken), expiresAt: session.expiresAt,
    });
    await audit(tx, 'auth.login_succeeded', user.id, { targetType: 'auth_session', targetId: session.id });
    return { ...target, sessionId: session.id, refreshToken };
  });
  if (!result) await audit(db, 'auth.login_denied', user?.id);
  return result;
}

export async function refresh(db: AuthDatabase, input: DeviceProof & { refreshToken: string }) {
  const tokenHash = digest(input.refreshToken);
  const [target] = await db.select({
    userId: authSessionsTable.userId, deviceId: authSessionsTable.deviceId, sessionId: authSessionsTable.id,
  }).from(refreshTokensTable).innerJoin(authSessionsTable, eq(authSessionsTable.id, refreshTokensTable.sessionId))
    .where(and(eq(refreshTokensTable.tokenHash, tokenHash), eq(authSessionsTable.deviceId, input.deviceId)));

  const result = target && await db.transaction(async (tx) => {
    if (!await lockActiveUser(tx, target.userId) ||
        !await verifyApprovedDevice(tx, target, input.deviceCredential)) return undefined;

    // Serialize all rotations for this family before reading consumption state.
    const [session] = await tx.select({ id: authSessionsTable.id }).from(authSessionsTable)
      .where(and(eq(authSessionsTable.id, target.sessionId), sessionActive)).for('update');
    if (!session) return undefined;

    const [token] = await tx.select({
      id: refreshTokensTable.id,
      consumedAt: refreshTokensTable.consumedAt,
      expiresAt: authSessionsTable.expiresAt,
      sessionExpired: sql<boolean>`${authSessionsTable.expiresAt} <= clock_timestamp()`,
      tokenExpired: sql<boolean>`${refreshTokensTable.expiresAt} <= clock_timestamp()`,
    }).from(refreshTokensTable).innerJoin(authSessionsTable, eq(authSessionsTable.id, refreshTokensTable.sessionId))
      .where(and(eq(refreshTokensTable.sessionId, session.id), eq(refreshTokensTable.tokenHash, tokenHash)));
    if (!token || token.sessionExpired) return undefined;
    if (token.consumedAt) {
      await tx.update(authSessionsTable).set({ revokedAt: sql`clock_timestamp()` })
        .where(eq(authSessionsTable.id, session.id));
      await audit(tx, 'auth.refresh_reuse', target.userId, { targetType: 'auth_session', targetId: session.id });
      return null; // Commit family revocation before reporting authentication failure.
    }
    if (token.tokenExpired) return undefined;

    await tx.update(refreshTokensTable).set({ consumedAt: sql`clock_timestamp()` })
      .where(eq(refreshTokensTable.id, token.id));
    const refreshToken = newRefreshToken();
    await tx.insert(refreshTokensTable).values({
      sessionId: session.id, previousTokenId: token.id, tokenHash: digest(refreshToken), expiresAt: token.expiresAt,
    });
    await audit(tx, 'auth.refresh_succeeded', target.userId, { targetType: 'auth_session', targetId: session.id });
    return { ...target, refreshToken };
  });
  if (result === undefined) await audit(db, 'auth.refresh_denied', target?.userId,
    target && { targetType: 'auth_session', targetId: target.sessionId });
  return result;
}

export async function activeSession(db: AuthDatabase, identity: SessionIdentity) {
  const [session] = await db.select({ id: authSessionsTable.id }).from(authSessionsTable)
    .innerJoin(usersTable, eq(usersTable.id, authSessionsTable.userId))
    .innerJoin(userDevicesTable, and(
      eq(userDevicesTable.id, authSessionsTable.deviceId), eq(userDevicesTable.userId, authSessionsTable.userId),
    )).where(and(
      eq(authSessionsTable.id, identity.sessionId), eq(authSessionsTable.userId, identity.userId),
      eq(authSessionsTable.deviceId, identity.deviceId), sessionActive,
      eq(usersTable.isActive, true), eq(userDevicesTable.status, 'approved'),
    ));
  return !!session;
}

export async function logout(db: AuthDatabase, identity: SessionIdentity) {
  await db.transaction(async (tx) => {
    const [session] = await tx.update(authSessionsTable).set({ revokedAt: sql`clock_timestamp()` }).where(and(
      eq(authSessionsTable.id, identity.sessionId), eq(authSessionsTable.userId, identity.userId),
      eq(authSessionsTable.deviceId, identity.deviceId), isNull(authSessionsTable.revokedAt),
    )).returning({ id: authSessionsTable.id });
    if (session) await audit(tx, 'auth.logout', identity.userId, { targetType: 'auth_session', targetId: session.id });
  });
}

export async function revokeDeviceSessions(db: AuthDatabase, userId: string, deviceId: string) {
  return db.transaction(async (tx) => {
    if (!await lockActiveUser(tx, userId)) return false;
    const [device] = await tx.select({ id: userDevicesTable.id }).from(userDevicesTable)
      .where(and(eq(userDevicesTable.userId, userId), eq(userDevicesTable.id, deviceId))).for('update');
    if (!device) return false;
    await tx.update(authSessionsTable).set({ revokedAt: sql`clock_timestamp()` }).where(and(
      eq(authSessionsTable.userId, userId), eq(authSessionsTable.deviceId, deviceId),
      isNull(authSessionsTable.revokedAt),
    ));
    await audit(tx, 'auth.device_sessions_revoked', userId, { targetType: 'user_device', targetId: deviceId });
    return true;
  });
}
