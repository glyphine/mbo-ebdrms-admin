ALTER TABLE "auth_logs" ADD COLUMN "target_type" varchar(100);--> statement-breakpoint
ALTER TABLE "auth_logs" ADD COLUMN "target_id" text;--> statement-breakpoint
CREATE INDEX "activity_logs_cursor_idx" ON "activity_logs" ("created_at","id");--> statement-breakpoint
CREATE INDEX "auth_logs_cursor_idx" ON "auth_logs" ("created_at","id");--> statement-breakpoint
CREATE INDEX "documents_report_sources_idx" ON "documents" ("template_id","id") WHERE "status" in ('finalized', 'archived');--> statement-breakpoint
ALTER TABLE "auth_logs" ADD CONSTRAINT "auth_logs_target_pair" CHECK (("target_type" is null) = ("target_id" is null));