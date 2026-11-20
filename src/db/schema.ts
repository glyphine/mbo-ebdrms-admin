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

// ---------------------------------------------------------------------------
// Shared document-generator contracts
// ---------------------------------------------------------------------------

export type DocValue =
  | string
  | number
  | boolean
  | null
  | DocValue[]
  | { [key: string]: DocValue };

export type DocValues = Record<string, DocValue>;

export interface DocFieldDefinition {
  key: string;
  label: string;
  type: "text" | "number" | "money" | "date" | "boolean" | "asset" | "group" | "list";
  required?: boolean;
  defaultValue?: DocValue;
  fields?: DocFieldDefinition[];
}

export interface PdfOptions {
  format: "A3" | "A4" | "A5" | "Letter" | "Legal";
  landscape: boolean;
  displayHeaderFooter: boolean;
  printBackground: boolean;
  margin: { top: string; right: string; bottom: string; left: string };
}

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
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

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
    fieldSchema: jsonb("field_schema").$type<DocFieldDefinition[]>().notNull(),
    pdfOptions: jsonb("pdf_options").$type<PdfOptions>().notNull(),
    changeNote: text("change_note"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => usersTable.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("template_versions_template_version_uq").on(t.templateId, t.versionNumber),
    check("template_versions_version_positive", sql`${t.versionNumber} >= 1`),
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
  ],
);

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
  ],
);

export const authLogsTable = pgTable(
  "auth_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Nullable for unknown users / failed sign-in attempts.
    userId: uuid("user_id").references(() => usersTable.id),
    action: varchar("action", { length: 100 }).notNull(),
    message: text("message"),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: text("user_agent"),
    // Do not record raw passwords, session secrets, or device tokens here.
    createdAt: createdAt(),
  },
  (t) => [
    index("auth_logs_user_idx").on(t.userId),
    index("auth_logs_created_at_idx").on(t.createdAt),
  ],
);
