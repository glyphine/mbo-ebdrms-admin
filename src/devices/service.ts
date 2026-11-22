import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { activityLogsTable, authSessionsTable, userDevicesTable, usersTable } from '../db/schema.js';

type DeviceDatabase = Pick<Database['db'], 'select' | 'transaction'>;
type DeviceTarget = { userId: string; deviceId: string };

function deviceEvent(actorUserId: string, target: DeviceTarget, action: string) {
  return {
    actorUserId,
    entityType: 'user_device',
    entityId: target.deviceId,
    action,
    metadata: { targetUserId: target.userId },
  };
}

function hashCredential(credential: string) {
  return createHash('sha256').update(credential).digest('hex');
}

// The caller must obtain authenticatedUserId from a verified account context.
export async function requestDeviceEnrollment(db: DeviceDatabase, authenticatedUserId: string, label: string) {
  const deviceLabel = label.trim();
  if (!deviceLabel || [...deviceLabel].length > 100 || deviceLabel.includes('\0')) {
    throw new Error('Device label must contain 1 to 100 characters without NUL');
  }

  const credential = randomBytes(32).toString('base64url');
  const credentialHash = hashCredential(credential);

  return db.transaction(async (tx) => {
    const [owner] = await tx.select({ id: usersTable.id }).from(usersTable)
      .where(and(eq(usersTable.id, authenticatedUserId), eq(usersTable.isActive, true)))
      .for('share');
    if (!owner) throw new Error('Device enrollment unavailable');

    const [device] = await tx.insert(userDevicesTable)
      .values({ userId: owner.id, label: deviceLabel, credentialHash })
      .returning({ deviceId: userDevicesTable.id, status: userDevicesTable.status });
    if (!device) throw new Error('Device enrollment insert returned no row');
    await tx.insert(activityLogsTable).values(deviceEvent(
      owner.id, { userId: owner.id, deviceId: device.deviceId }, 'device.enrollment_requested',
    ));
    return { ...device, credential };
  });
}

// Only a trusted maintenance caller or a future RBAC guard may invoke these transitions.
export async function approveDevice(db: DeviceDatabase, actorUserId: string, target: DeviceTarget) {
  return db.transaction(async (tx) => {
    const [owner] = await tx.select({ id: usersTable.id }).from(usersTable)
      .where(and(eq(usersTable.id, target.userId), eq(usersTable.isActive, true)))
      .for('share');
    if (!owner) return false;

    const [device] = await tx.update(userDevicesTable).set({ status: 'approved', approvedAt: sql`clock_timestamp()` })
      .where(and(
        eq(userDevicesTable.id, target.deviceId),
        eq(userDevicesTable.userId, target.userId),
        eq(userDevicesTable.status, 'pending'),
      )).returning({ id: userDevicesTable.id });
    if (!device) return false;

    await tx.insert(activityLogsTable).values(deviceEvent(actorUserId, target, 'device.approved'));
    return true;
  });
}

export async function revokeDevice(db: DeviceDatabase, actorUserId: string, target: DeviceTarget) {
  return db.transaction(async (tx) => {
    const [device] = await tx.update(userDevicesTable).set({ status: 'revoked', revokedAt: sql`clock_timestamp()` })
      .where(and(
        eq(userDevicesTable.id, target.deviceId),
        eq(userDevicesTable.userId, target.userId),
        ne(userDevicesTable.status, 'revoked'),
      )).returning({ id: userDevicesTable.id });
    if (!device) return false;

    await tx.update(authSessionsTable).set({ revokedAt: sql`clock_timestamp()` }).where(and(
      eq(authSessionsTable.userId, target.userId),
      eq(authSessionsTable.deviceId, target.deviceId),
      isNull(authSessionsTable.revokedAt),
    ));
    await tx.insert(activityLogsTable).values(deviceEvent(actorUserId, target, 'device.revoked'));
    return true;
  });
}

export async function verifyApprovedDevice(
  db: Pick<DeviceDatabase, 'select'>, target: DeviceTarget, credential: string,
) {
  if (credential.length !== 43 || /[^A-Za-z0-9_-]/.test(credential)) return false;

  const [device] = await db.select({ credentialHash: userDevicesTable.credentialHash }).from(userDevicesTable)
    .innerJoin(usersTable, eq(usersTable.id, userDevicesTable.userId))
    .where(and(
      eq(userDevicesTable.id, target.deviceId),
      eq(userDevicesTable.userId, target.userId),
      eq(userDevicesTable.status, 'approved'),
      eq(usersTable.isActive, true),
    )).for('share', { of: userDevicesTable });

  return !!device && timingSafeEqual(
    Buffer.from(device.credentialHash, 'hex'), Buffer.from(hashCredential(credential), 'hex'),
  );
}
