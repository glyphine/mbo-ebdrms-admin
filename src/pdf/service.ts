import type { Database } from '../db/client.js';
import { activityLogsTable } from '../db/schema.js';
import { DocumentError, findDocumentRevision, readDocument } from '../documents/service.js';
import { hasGrant, permitsDocumentStatus, userGrants } from '../rbac/permissions.js';
import { loadPublishedTemplateVersion } from '../templates/publication.js';
import type { PdfRenderer } from './renderer.js';

export async function exportRevisionPdf(db: Database['db'], renderer: PdfRenderer, actor: string, documentId: string, revisionNumber: number) {
  const document = await readDocument(db, actor, documentId);
  if (!permitsDocumentStatus('documents.export', document.status) ||
      !hasGrant(await userGrants(db, actor), 'documents.export', document.documentTypeId)) {
    throw new DocumentError(403, 'Permission denied');
  }

  const revision = await findDocumentRevision(db, document, revisionNumber);
  const pdf = await renderer.render(async () => {
    const content = await loadPublishedTemplateVersion(db, revision.templateVersionId);
    if (!content || content.templateId !== document.templateId || content.renderSnapshot.code !== document.documentTypeCode) {
      throw new DocumentError(409, 'Pinned template version is unavailable');
    }
    return { content, contentDigest: content.contentDigest, values: revision.values };
  });

  await db.insert(activityLogsTable).values({ actorUserId: actor, entityType: 'document', entityId: document.id,
    action: 'document.pdf_exported', metadata: { revisionId: revision.id, revisionNumber: revision.revisionNumber,
      templateVersionId: revision.templateVersionId } });
  return { pdf, filename: `${document.documentTypeCode}-${document.id}-r${revision.revisionNumber}.pdf` };
}
