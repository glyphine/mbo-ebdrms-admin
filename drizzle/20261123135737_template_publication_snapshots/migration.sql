ALTER TABLE "template_versions" ADD COLUMN "render_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "content_digest" varchar(64);--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_snapshot_pair" CHECK (("render_snapshot" IS NULL AND "content_digest" IS NULL)
      OR ("render_snapshot" IS NOT NULL AND "content_digest" IS NOT NULL AND "content_digest" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
CREATE FUNCTION prevent_template_version_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Template versions are append-only' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER template_versions_append_only
BEFORE UPDATE OR DELETE ON "template_versions"
FOR EACH ROW EXECUTE FUNCTION prevent_template_version_mutation();
