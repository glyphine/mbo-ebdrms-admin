import { pgTable, varchar, uuid, text, timestamp, boolean, serial, json } from "drizzle-orm/pg-core";

// RBAC-based Features

export const usersTable = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar({ length: 255 }).notNull().unique(),
  password: varchar({ length: 255 }).notNull(),
  fullName: varchar({ length: 255 }).notNull(),
  profileUrl: text("profileUrl").notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const rolesTable = pgTable("roles", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar({ length: 255 }).notNull(),
  description: text("description").notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const userRolesTable = pgTable("userRoles", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("userId").references(() => usersTable.id),
  roleId: uuid("roleId").references(() => rolesTable.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const permissionsTable = pgTable("permissions", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar({ length: 255 }).notNull(),
  description: text("description").notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const rolePermissionsTable = pgTable("rolePermissions", {
  id: uuid("id").defaultRandom().primaryKey(),
  roleId: uuid("roleId").references(() => rolesTable.id),
  permissionId: uuid("permissionId").references(() => permissionsTable.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

// Audit Logs

export const activitLogsTables = pgTable("activityLogs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("userId").references(() => usersTable.id),
  modelName: varchar({ length: 255 }).notNull(),
  modelId: varchar({ length: 255 }).notNull(),
  code: varchar({ length: 255 }).notNull(),
  message: text("message").notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const authLogsTable = pgTable("authLogs", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceToken: varchar({ length: 255 }).notNull(),
  code: varchar({ length: 255 }).notNull(),
  message: text("message").notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

// Doc Management

export const docTemplatesTable = pgTable("docTemplates", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar({ length: 255 }).notNull(),
  description: text("description").notNull(),
  status: boolean().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const docResourcesTable = pgTable("docResources", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar({ length: 255 }).notNull(),
  description: text("description").notNull(),
  version: serial("version").notNull(),
  resource: text("resource").notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const docResourceTemplatesTable = pgTable("docResourceTemplates", {
  id: uuid("id").defaultRandom().primaryKey(),
  docTemplateId: uuid("docTemplateId").references(() => docTemplatesTable.id),
  docResourceId: uuid("docResourceId").references(() => docResourcesTable.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
})

export const docFieldTemplatesTable = pgTable("docFieldTemplates", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: varchar({ length: 255 }).notNull(),
  label: varchar({ length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const docFieldChildrenTable = pgTable("docFieldChildren", {
  id: uuid("id").defaultRandom().primaryKey(),
  parentFieldId: uuid("parentFieldId").references(() => docFieldTemplatesTable.id),
  childFieldId: uuid("childFieldId").references(() => docFieldTemplatesTable.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const docEntriesTable = pgTable("docEntries", {
  id: uuid("id").defaultRandom().primaryKey(),
  docTemplateId: uuid("docTemplateId").references(() => docTemplatesTable.id),
  userId: uuid("userId").references(() => usersTable.id),
  name: varchar({ length: 255 }).notNull(),
  description: text("description").notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const docFieldEntriesTable = pgTable("docFieldEntries", {
  id: uuid("id").defaultRandom().primaryKey(),
  docEntryId: uuid("docEntryId").references(() => docEntriesTable.id),
  value: json("value").notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const fieldToTemplatesTable = pgTable("fieldToTemplates", {
  id: uuid("id").defaultRandom().primaryKey(),
  docFieldTemplateId: uuid("docFieldTemplateId").references(() => docFieldTemplatesTable.id),
  docFieldEntryId: uuid("docFieldEntryId").references(() => docFieldEntriesTable.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

