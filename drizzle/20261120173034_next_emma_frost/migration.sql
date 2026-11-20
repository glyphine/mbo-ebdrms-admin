CREATE TYPE "document_revision_status" AS ENUM('draft', 'finalized');--> statement-breakpoint
CREATE TYPE "document_status" AS ENUM('draft', 'finalized', 'voided');--> statement-breakpoint
CREATE TABLE "activity_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"actor_user_id" uuid,
	"entity_type" varchar(100) NOT NULL,
	"entity_id" text NOT NULL,
	"action" varchar(100) NOT NULL,
	"message" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid,
	"action" varchar(100) NOT NULL,
	"message" text,
	"ip_address" varchar(64),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_financial_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"revision_id" uuid NOT NULL,
	"field_path" text NOT NULL,
	"metric_key" varchar(100) NOT NULL,
	"office_id" uuid,
	"account_code" varchar(64),
	"fiscal_year" integer,
	"amount" numeric(18,2) NOT NULL,
	"is_aggregate" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_revision_signatories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"revision_id" uuid NOT NULL,
	"signatory_id" uuid,
	"slot_key" varchar(100) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"display_designation" varchar(255) NOT NULL,
	"display_date" date
);
--> statement-breakpoint
CREATE TABLE "document_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"document_id" uuid NOT NULL,
	"template_version_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"values" jsonb NOT NULL,
	"status" "document_revision_status" DEFAULT 'draft'::"document_revision_status" NOT NULL,
	"change_note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_revisions_revision_positive" CHECK ("revision_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "document_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"document_type_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"resource_key" varchar(255) NOT NULL UNIQUE,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"code" varchar(50) NOT NULL UNIQUE,
	"name" varchar(255) NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"template_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"managing_office_id" uuid,
	"title" varchar(255) NOT NULL,
	"description" text,
	"reference_number" varchar(100),
	"fiscal_year" integer,
	"status" "document_status" DEFAULT 'draft'::"document_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"code" varchar(32) NOT NULL UNIQUE,
	"name" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" varchar(150) NOT NULL UNIQUE,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_document_type_permissions" (
	"role_id" uuid,
	"document_type_id" uuid,
	"permission_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_document_type_permissions_pkey" PRIMARY KEY("role_id","document_type_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid,
	"permission_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_pkey" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" varchar(100) NOT NULL UNIQUE,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signatories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"full_name" varchar(255) NOT NULL,
	"designation" varchar(255) NOT NULL,
	"office_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"template_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"template_source" text NOT NULL,
	"field_schema" jsonb NOT NULL,
	"pdf_options" jsonb NOT NULL,
	"change_note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_versions_version_positive" CHECK ("version_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid,
	"role_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_roles_pkey" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"email" varchar(255) NOT NULL UNIQUE,
	"password_hash" text NOT NULL,
	"full_name" varchar(255) NOT NULL,
	"profile_url" text,
	"office_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "activity_logs_entity_idx" ON "activity_logs" ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "activity_logs_actor_idx" ON "activity_logs" ("actor_user_id");--> statement-breakpoint
CREATE INDEX "activity_logs_created_at_idx" ON "activity_logs" ("created_at");--> statement-breakpoint
CREATE INDEX "auth_logs_user_idx" ON "auth_logs" ("user_id");--> statement-breakpoint
CREATE INDEX "auth_logs_created_at_idx" ON "auth_logs" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_financial_values_path_uq" ON "document_financial_values" ("revision_id","field_path");--> statement-breakpoint
CREATE INDEX "document_financial_values_office_metric_year_idx" ON "document_financial_values" ("office_id","metric_key","fiscal_year");--> statement-breakpoint
CREATE INDEX "document_financial_values_account_idx" ON "document_financial_values" ("account_code");--> statement-breakpoint
CREATE UNIQUE INDEX "document_revision_signatory_slot_uq" ON "document_revision_signatories" ("revision_id","slot_key");--> statement-breakpoint
CREATE INDEX "document_revision_signatory_person_idx" ON "document_revision_signatories" ("signatory_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_revisions_document_revision_uq" ON "document_revisions" ("document_id","revision_number");--> statement-breakpoint
CREATE INDEX "document_revisions_template_version_idx" ON "document_revisions" ("template_version_id");--> statement-breakpoint
CREATE INDEX "document_revisions_author_idx" ON "document_revisions" ("created_by");--> statement-breakpoint
CREATE INDEX "document_templates_type_idx" ON "document_templates" ("document_type_id");--> statement-breakpoint
CREATE INDEX "documents_template_idx" ON "documents" ("template_id");--> statement-breakpoint
CREATE INDEX "documents_created_by_idx" ON "documents" ("created_by");--> statement-breakpoint
CREATE INDEX "documents_office_year_idx" ON "documents" ("managing_office_id","fiscal_year");--> statement-breakpoint
CREATE INDEX "documents_status_idx" ON "documents" ("status");--> statement-breakpoint
CREATE INDEX "role_doc_type_perm_type_idx" ON "role_document_type_permissions" ("document_type_id");--> statement-breakpoint
CREATE INDEX "role_doc_type_perm_permission_idx" ON "role_document_type_permissions" ("permission_id");--> statement-breakpoint
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions" ("permission_id");--> statement-breakpoint
CREATE INDEX "signatories_office_idx" ON "signatories" ("office_id");--> statement-breakpoint
CREATE UNIQUE INDEX "template_versions_template_version_uq" ON "template_versions" ("template_id","version_number");--> statement-breakpoint
CREATE INDEX "user_roles_role_id_idx" ON "user_roles" ("role_id");--> statement-breakpoint
CREATE INDEX "users_office_id_idx" ON "users" ("office_id");--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_actor_user_id_users_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "auth_logs" ADD CONSTRAINT "auth_logs_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "document_financial_values" ADD CONSTRAINT "document_financial_values_0xcP7bxIU26l_fkey" FOREIGN KEY ("revision_id") REFERENCES "document_revisions"("id");--> statement-breakpoint
ALTER TABLE "document_financial_values" ADD CONSTRAINT "document_financial_values_office_id_offices_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id");--> statement-breakpoint
ALTER TABLE "document_revision_signatories" ADD CONSTRAINT "document_revision_signatories_2z5Kk7d8wLZl_fkey" FOREIGN KEY ("revision_id") REFERENCES "document_revisions"("id");--> statement-breakpoint
ALTER TABLE "document_revision_signatories" ADD CONSTRAINT "document_revision_signatories_signatory_id_signatories_id_fkey" FOREIGN KEY ("signatory_id") REFERENCES "signatories"("id");--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_document_id_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id");--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_59nhiy0IRSIp_fkey" FOREIGN KEY ("template_version_id") REFERENCES "template_versions"("id");--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_created_by_users_id_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_document_type_id_document_types_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "document_types"("id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_template_id_document_templates_id_fkey" FOREIGN KEY ("template_id") REFERENCES "document_templates"("id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_users_id_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_managing_office_id_offices_id_fkey" FOREIGN KEY ("managing_office_id") REFERENCES "offices"("id");--> statement-breakpoint
ALTER TABLE "role_document_type_permissions" ADD CONSTRAINT "role_document_type_permissions_role_id_roles_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "role_document_type_permissions" ADD CONSTRAINT "role_document_type_permissions_PqPdautRUeOn_fkey" FOREIGN KEY ("document_type_id") REFERENCES "document_types"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "role_document_type_permissions" ADD CONSTRAINT "role_document_type_permissions_XR7m9pnpSjLb_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "signatories" ADD CONSTRAINT "signatories_office_id_offices_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id");--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_template_id_document_templates_id_fkey" FOREIGN KEY ("template_id") REFERENCES "document_templates"("id");--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_created_by_users_id_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_office_id_offices_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id");