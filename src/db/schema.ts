/**
 * E-BDRMS PostgreSQL schema (Drizzle ORM).
 *
 * Document pipeline:
 *   document type -> template -> immutable template version
 *   template -> document -> immutable document revision
 *
 * The saved form values and template definitions are JSONB so that CAFOA,
 * RAAO (CO/FE/MOOE/PS), and SAAOB can have different, nested field shapes.
 * Reportable monetary amounts are additionally projected into typed rows.
 *
 * Important application invariants (not automatically guaranteed by FKs):
 *  1. Never UPDATE or DELETE a template version or document revision.
 *  2. A revision's templateVersionId must belong to its document's templateId.
 *  3. Allocate version/revision numbers transactionally (unique keys below).
 *  4. Insert/update reportable financial rows and signatory snapshots in the
 *     same transaction that creates their document revision.
 *  5. Enforce document-type permissions in server-side authorization.
 *  6. The existing filesystem Eta renderer must load templateSource from the
 *     database, or else the database is not the master template registry.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { DocField, DocValue, DocValues, PdfOptions, RenderSnapshot } from "../templates/contracts.js";

// ---------------------------------------------------------------------------
// Shared document-generator contracts
// ---------------------------------------------------------------------------

export type { DocField as DocFieldDefinition, DocValue, DocValues, PdfOptions } from "../templates/contracts.js";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

// Drizzle ORM runtime behavior, NOT a PostgreSQL ON UPDATE trigger.
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull();

export const documentStatusEnum = pgEnum("document_status", [
  "draft",
  "finalized",
  "voided",
  "archived",
]);

export const documentRevisionStatusEnum = pgEnum("document_revision_status", [
  "draft",
  "finalized",
]);

// ---------------------------------------------------------------------------
// Offices, identities, and authorization
// ---------------------------------------------------------------------------

export const officesTable = pgTable("offices", {
  id: uuid("id").defaultRandom().primaryKey(),
  // Store municipal codes as strings, e.g. "1071", "1011 (1)", "5999".
  code: varchar("code", { length: 32 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  parentOfficeId: uuid("parent_office_id").references((): AnyPgColumn => officesTable.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("offices_parent_office_idx").on(t.parentOfficeId),
  check("offices_parent_not_self", sql`${t.parentOfficeId} <> ${t.id}`),
]);

export const fundsTable = pgTable("funds", {
  code: varchar("code", { length: 3 }).primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
}, (t) => [check("funds_code_format", sql`${t.code} ~ '^[0-9]{3}$'`)]);

export const expenditureClassificationsTable = pgTable("expenditure_classifications", {
  code: varchar("code", { length: 8 }).primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  kind: varchar("kind", { length: 8, enum: ['class', 'grouping'] }).notNull(),
}, (t) => [check("expenditure_classifications_kind", sql`${t.kind} in ('class', 'grouping')`)]);

export const usersTable = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    // Store a secure password hash, never the raw password.
    passwordHash: text("password_hash").notNull(),
    fullName: varchar("full_name", { length: 255 }).notNull(),
    profileUrl: text("profile_url"),
    officeId: uuid("office_id").references(() => officesTable.id),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("users_office_id_idx").on(t.officeId)],
);

export const deviceStatusEnum = pgEnum("device_status", ["pending", "approved", "revoked"]);

export const userDevicesTable = pgTable(
  "user_devices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => usersTable.id),
    label: varchar("label", { length: 100 }).notNull(),
    credentialHash: varchar("credential_hash", { length: 64 }).notNull().unique(),
    status: deviceStatusEnum("status").default("pending").notNull(),
    createdAt: createdAt(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("user_devices_owner_id_uq").on(t.userId, t.id),
    index("user_devices_pending_idx").on(t.createdAt).where(sql`${t.status} = 'pending'`),
    check("user_devices_label_nonblank", sql`btrim(${t.label}) <> ''`),
    check("user_devices_credential_hash_format", sql`${t.credentialHash} ~ '^[0-9a-f]{64}$'`),
    check("user_devices_status_timestamps", sql`
      (${t.status} = 'pending' AND ${t.approvedAt} IS NULL AND ${t.revokedAt} IS NULL)
      OR (${t.status} = 'approved' AND ${t.approvedAt} IS NOT NULL AND ${t.revokedAt} IS NULL)
      OR (${t.status} = 'revoked' AND ${t.revokedAt} IS NOT NULL)
    `),
  ],
);

export const authSessionsTable = pgTable(
  "auth_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "auth_sessions_device_owner_fk",
      columns: [t.userId, t.deviceId],
      foreignColumns: [userDevicesTable.userId, userDevicesTable.id],
    }),
    index("auth_sessions_device_owner_idx").on(t.userId, t.deviceId),
    check("auth_sessions_expiry_after_creation", sql`${t.expiresAt} > ${t.createdAt}`),
    check("auth_sessions_revocation_after_creation", sql`${t.revokedAt} >= ${t.createdAt}`),
  ],
);

export const refreshTokensTable = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id").notNull().references(() => authSessionsTable.id),
    previousTokenId: uuid("previous_token_id"),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("refresh_tokens_session_id_uq").on(t.sessionId, t.id),
    foreignKey({
      name: "refresh_tokens_previous_session_fk",
      columns: [t.sessionId, t.previousTokenId],
      foreignColumns: [t.sessionId, t.id],
    }),
    uniqueIndex("refresh_tokens_previous_uq").on(t.previousTokenId).where(sql`${t.previousTokenId} IS NOT NULL`),
    uniqueIndex("refresh_tokens_session_root_uq").on(t.sessionId).where(sql`${t.previousTokenId} IS NULL`),
    uniqueIndex("refresh_tokens_session_unconsumed_uq").on(t.sessionId).where(sql`${t.consumedAt} IS NULL`),
    check("refresh_tokens_hash_format", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("refresh_tokens_previous_not_self", sql`${t.previousTokenId} <> ${t.id}`),
    check("refresh_tokens_expiry_after_creation", sql`${t.expiresAt} > ${t.createdAt}`),
    check("refresh_tokens_consumption_after_creation", sql`${t.consumedAt} >= ${t.createdAt}`),
  ],
);

export const rolesTable = pgTable("roles", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  description: text("description"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const permissionsTable = pgTable("permissions", {
  id: uuid("id").defaultRandom().primaryKey(),
  // E.g. "users.manage", "documents.read", "documents.finalize".
  name: varchar("name", { length: 150 }).notNull().unique(),
  description: text("description"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const userRolesTable = pgTable(
  "user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => rolesTable.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.roleId] }),
    index("user_roles_role_id_idx").on(t.roleId),
  ],
);

// General application permissions (non-document-type-specific).
export const rolePermissionsTable = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => rolesTable.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissionsTable.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.permissionId] }),
    index("role_permissions_permission_id_idx").on(t.permissionId),
  ],
);

// ---------------------------------------------------------------------------
// Document types and master templates
// ---------------------------------------------------------------------------

export const documentTypesTable = pgTable("document_types", {
  id: uuid("id").defaultRandom().primaryKey(),
  // Seed: CAFOA, RAAOCO, RAAOFE, RAAOMOOE, RAAOPS, SAAOB.
  code: varchar("code", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// A permission may be granted for a specific document type without granting
// the same action on every other document type.
export const roleDocumentTypePermissionsTable = pgTable(
  "role_document_type_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => rolesTable.id, { onDelete: "cascade" }),
    documentTypeId: uuid("document_type_id")
      .notNull()
      .references(() => documentTypesTable.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissionsTable.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.documentTypeId, t.permissionId] }),
    index("role_doc_type_perm_type_idx").on(t.documentTypeId),
    index("role_doc_type_perm_permission_idx").on(t.permissionId),
  ],
);

export const documentTemplatesTable = pgTable(
  "document_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentTypeId: uuid("document_type_id")
      .notNull()
      .references(() => documentTypesTable.id),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    // Compatibility identifier used by the existing generator, e.g.
    // "/templates/cafoa". NOT the authoritative template contents.
    resourceKey: varchar("resource_key", { length: 255 }).notNull().unique(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("document_templates_type_idx").on(t.documentTypeId)],
);

export const templateVersionsTable = pgTable(
  "template_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => documentTemplatesTable.id),
    versionNumber: integer("version_number").notNull(),
    // The actual, versioned Eta/HTML master template source in PostgreSQL.
    templateSource: text("template_source").notNull(),
    // Definitions of input controls, including nested list/group structures.
    fieldSchema: jsonb("field_schema").$type<readonly DocField[]>().notNull(),
    pdfOptions: jsonb("pdf_options").$type<PdfOptions>().notNull(),
    renderSnapshot: jsonb("render_snapshot").$type<RenderSnapshot>(),
    contentDigest: varchar("content_digest", { length: 64 }),
    changeNote: text("change_note"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => usersTable.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("template_versions_template_version_uq").on(t.templateId, t.versionNumber),
    check("template_versions_version_positive", sql`${t.versionNumber} >= 1`),
    check("template_versions_snapshot_pair", sql`(${t.renderSnapshot} IS NULL AND ${t.contentDigest} IS NULL)
      OR (${t.renderSnapshot} IS NOT NULL AND ${t.contentDigest} IS NOT NULL AND ${t.contentDigest} ~ '^[0-9a-f]{64}$')`),
  ],
);

// ---------------------------------------------------------------------------
// Completed documents and append-only revisions
// ---------------------------------------------------------------------------

export const documentsTable = pgTable(
  "documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => documentTemplatesTable.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => usersTable.id),
    // An managing office is distinct from the offices listed inside SAAOB.
    managingOfficeId: uuid("managing_office_id").references(() => officesTable.id),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    referenceNumber: varchar("reference_number", { length: 100 }),
    fiscalYear: integer("fiscal_year"),
    serialNumber: varchar("serial_number", { length: 14 }).unique(),
    serialFundCode: varchar("serial_fund_code", { length: 3 }).references(() => fundsTable.code),
    // Current lifecycle state; keep in sync with the saved revisions.
    status: documentStatusEnum("status").default("draft").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("documents_template_idx").on(t.templateId),
    index("documents_created_by_idx").on(t.createdBy),
    index("documents_office_year_idx").on(t.managingOfficeId, t.fiscalYear),
    index("documents_status_idx").on(t.status),
    index("documents_serial_fund_idx").on(t.serialFundCode).where(sql`${t.serialFundCode} is not null`),
    check("documents_serial_format", sql`(${t.serialNumber} is null and ${t.serialFundCode} is null) or (
      ${t.serialNumber} is not null and ${t.serialFundCode} is not null and
      ${t.serialNumber} ~ '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}-[0-9]{3}$' and
      left(${t.serialNumber}, 4) <> '0000' and right(${t.serialNumber}, 3) = ${t.serialFundCode})`),
    index("documents_report_sources_idx").on(t.templateId, t.id)
      .where(sql`${t.status} in ('finalized', 'archived')`),
  ],
);

export const documentSerialCountersTable = pgTable("document_serial_counters", {
  year: integer("year").primaryKey(),
  lastValue: integer("last_value").notNull(),
}, (t) => [
  check("document_serial_counters_year", sql`${t.year} between 1 and 9999`),
  check("document_serial_counters_range", sql`${t.lastValue} between 1 and 9999`),
]);

export const documentRevisionsTable = pgTable(
  "document_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documentsTable.id),
    templateVersionId: uuid("template_version_id")
      .notNull()
      .references(() => templateVersionsTable.id),
    revisionNumber: integer("revision_number").notNull(),
    // This is the data passed to Eta, e.g. fields for CAFOA/RAAO/SAAOB.
    values: jsonb("values").$type<DocValues>().notNull(),
    status: documentRevisionStatusEnum("status").default("draft").notNull(),
    changeNote: text("change_note"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => usersTable.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("document_revisions_document_revision_uq").on(t.documentId, t.revisionNumber),
    index("document_revisions_template_version_idx").on(t.templateVersionId),
    index("document_revisions_author_idx").on(t.createdBy),
    check("document_revisions_revision_positive", sql`${t.revisionNumber} >= 1`),
  ],
);

// ---------------------------------------------------------------------------
// Signatories: people who may appear on documents but are not login users.
// ---------------------------------------------------------------------------

export const signatoriesTable = pgTable(
  "signatories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fullName: varchar("full_name", { length: 255 }).notNull(),
    designation: varchar("designation", { length: 255 }).notNull(),
    officeId: uuid("office_id").references(() => officesTable.id),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("signatories_office_idx").on(t.officeId)],
);

export const documentRevisionSignatoriesTable = pgTable(
  "document_revision_signatories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => documentRevisionsTable.id),
    // Nullable for imported or manually entered signatory details.
    signatoryId: uuid("signatory_id").references(() => signatoriesTable.id),
    // E.g. "signatory1", "signatory2", "preparedBy", "certifiedBy".
    slotKey: varchar("slot_key", { length: 100 }).notNull(),
    // Immutable display snapshots, even if the registry later changes.
    displayName: varchar("display_name", { length: 255 }).notNull(),
    displayDesignation: varchar("display_designation", { length: 255 }).notNull(),
    displayDate: date("display_date", { mode: "string" }),
  },
  (t) => [
    uniqueIndex("document_revision_signatory_slot_uq").on(t.revisionId, t.slotKey),
    index("document_revision_signatory_person_idx").on(t.signatoryId),
  ],
);

// ---------------------------------------------------------------------------
// Typed financial projections for reports; one row per reportable field path.
// ---------------------------------------------------------------------------

export const documentFinancialValuesTable = pgTable(
  "document_financial_values",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => documentRevisionsTable.id),
    // A stable address into the revision JSON, including repeated row keys.
    // E.g. "offices[0].categories[0].entries[1].obligation".
    fieldPath: text("field_path").notNull(),
    metricKey: varchar("metric_key", { length: 100 }).notNull(),
    // Applicable to SAAOB office rows and other office-specific entries.
    officeId: uuid("office_id").references(() => officesTable.id),
    accountCode: varchar("account_code", { length: 64 }),
    fiscalYear: integer("fiscal_year"),
    // PostgreSQL NUMERIC; Drizzle returns decimal strings by default.
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    // True for category/office/grand totals. Exclude from detail-only sums.
    isAggregate: boolean("is_aggregate").default(false).notNull(),
  },
  (t) => [
    uniqueIndex("document_financial_values_path_uq").on(t.revisionId, t.fieldPath),
    index("document_financial_values_office_metric_year_idx").on(
      t.officeId,
      t.metricKey,
      t.fiscalYear,
    ),
    index("document_financial_values_account_idx").on(t.accountCode),
  ],
);

// ---------------------------------------------------------------------------
// Append-only audit / authentication events
// ---------------------------------------------------------------------------

export const activityLogsTable = pgTable(
  "activity_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorUserId: uuid("actor_user_id").references(() => usersTable.id),
    entityType: varchar("entity_type", { length: 100 }).notNull(),
    // Text accommodates UUID-based entities and string-based office codes.
    entityId: text("entity_id").notNull(),
    action: varchar("action", { length: 100 }).notNull(),
    message: text("message"),
    metadata: jsonb("metadata").$type<Record<string, DocValue>>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("activity_logs_entity_idx").on(t.entityType, t.entityId),
    index("activity_logs_actor_idx").on(t.actorUserId),
    index("activity_logs_created_at_idx").on(t.createdAt),
    index("activity_logs_cursor_idx").on(t.createdAt, t.id),
  ],
);

export const authLogsTable = pgTable(
  "auth_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Nullable for unknown users / failed sign-in attempts.
    userId: uuid("user_id").references(() => usersTable.id),
    action: varchar("action", { length: 100 }).notNull(),
    targetType: varchar("target_type", { length: 100 }),
    targetId: text("target_id"),
    message: text("message"),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: text("user_agent"),
    // Do not record raw passwords, session secrets, or device tokens here.
    createdAt: createdAt(),
  },
  (t) => [
    index("auth_logs_user_idx").on(t.userId),
    index("auth_logs_created_at_idx").on(t.createdAt),
    index("auth_logs_cursor_idx").on(t.createdAt, t.id),
    check("auth_logs_target_pair", sql`(${t.targetType} is null) = (${t.targetId} is null)`),
  ],
);
