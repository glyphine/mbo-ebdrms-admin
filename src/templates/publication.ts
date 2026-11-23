import { desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { activityLogsTable, documentTemplatesTable, documentTypesTable, templateVersionsTable, usersTable } from '../db/schema.js';
import type { TemplateCode } from './contracts.js';
import { documentRegistry } from './registry.js';
import { readPublication, snapshotDigest } from './snapshot.js';

type PublicationDatabase = Pick<Database['db'], 'select' | 'transaction'>;

// The maintenance caller must supply a digest approved for the exact checkout it deploys.
export async function publishTemplate(db: PublicationDatabase, code: TemplateCode, actorUserId: string, expectedDigest: string,
  trustedDirectory?: string) {
  const content = await readPublication(code, trustedDirectory);
  const digest = snapshotDigest(content);
  if (expectedDigest !== digest) throw new Error('Template content differs from the approved digest');
  const entry = documentRegistry[code];

  return db.transaction(async (tx) => {
    const [actor] = await tx.select({ id: usersTable.id, active: usersTable.isActive }).from(usersTable)
      .where(eq(usersTable.id, actorUserId)).for('share');
    if (!actor?.active) throw new Error('Publication requires an active operator account');

    await tx.insert(documentTypesTable).values({ code, name: entry.name }).onConflictDoNothing();
    const [type] = await tx.select({ id: documentTypesTable.id }).from(documentTypesTable).where(eq(documentTypesTable.code, code));
    if (!type) throw new Error('Document type could not be resolved');

    await tx.insert(documentTemplatesTable).values({ documentTypeId: type.id, name: entry.name, resourceKey: entry.resourceKey })
      .onConflictDoNothing();
    const [template] = await tx.select({ id: documentTemplatesTable.id, documentTypeId: documentTemplatesTable.documentTypeId })
      .from(documentTemplatesTable).where(eq(documentTemplatesTable.resourceKey, entry.resourceKey)).for('update');
    if (!template || template.documentTypeId !== type.id) throw new Error('Template identity conflicts with the reviewed registry');

    const projection = { id: templateVersionsTable.id, versionNumber: templateVersionsTable.versionNumber,
      digest: templateVersionsTable.contentDigest };
    const [latest] = await tx.select(projection).from(templateVersionsTable).where(eq(templateVersionsTable.templateId, template.id))
      .orderBy(desc(templateVersionsTable.versionNumber)).limit(1);
    if (latest?.digest === digest) {
      await loadPublishedTemplateVersion(tx, latest.id);
      return { ...latest, templateId: template.id, published: false };
    }

    const [version] = await tx.insert(templateVersionsTable).values({
      ...content, contentDigest: digest, templateId: template.id, versionNumber: (latest?.versionNumber ?? 0) + 1, createdBy: actor.id,
    }).returning(projection);
    if (!version) throw new Error('Template publication insert returned no version');
    await tx.insert(activityLogsTable).values({ actorUserId: actor.id, entityType: 'template_version', entityId: version.id,
      action: 'template.published', metadata: { templateId: template.id, versionNumber: version.versionNumber, contentDigest: digest } });
    return { ...version, templateId: template.id, published: true };
  });
}

// Internal lookup for an already authorized revision. Load by its pinned version ID.
export async function loadPublishedTemplateVersion(db: Pick<PublicationDatabase, 'select'>, versionId: string) {
  const [version] = await db.select().from(templateVersionsTable).where(eq(templateVersionsTable.id, versionId));
  if (!version?.renderSnapshot || !version.contentDigest) return undefined;
  const content = { ...version, renderSnapshot: version.renderSnapshot, contentDigest: version.contentDigest };
  if (content.renderSnapshot.format !== 1 || snapshotDigest(content) !== version.contentDigest) {
    throw new Error('Stored template snapshot failed integrity verification');
  }
  return content;
}
