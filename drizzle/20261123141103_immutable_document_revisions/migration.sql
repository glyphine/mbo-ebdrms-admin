ALTER TYPE "document_status" ADD VALUE 'archived';--> statement-breakpoint
CREATE FUNCTION prevent_document_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Document history is append-only' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER document_revisions_append_only BEFORE UPDATE OR DELETE ON document_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_document_history_mutation();--> statement-breakpoint
CREATE TRIGGER document_signatory_snapshots_append_only BEFORE UPDATE OR DELETE ON document_revision_signatories
FOR EACH ROW EXECUTE FUNCTION prevent_document_history_mutation();--> statement-breakpoint
CREATE TRIGGER document_financial_values_append_only BEFORE UPDATE OR DELETE ON document_financial_values
FOR EACH ROW EXECUTE FUNCTION prevent_document_history_mutation();--> statement-breakpoint
CREATE TRIGGER documents_template_immutable BEFORE UPDATE OF template_id ON documents
FOR EACH ROW WHEN (OLD.template_id IS DISTINCT FROM NEW.template_id)
EXECUTE FUNCTION prevent_document_history_mutation();--> statement-breakpoint
CREATE FUNCTION enforce_document_revision_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  document_template uuid;
  pinned_version uuid;
BEGIN
  SELECT template_id INTO document_template FROM documents WHERE id = NEW.document_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM template_versions
    WHERE id = NEW.template_version_id AND template_id = document_template AND content_digest IS NOT NULL) THEN
    RAISE EXCEPTION 'Revision requires a published version of its document template' USING ERRCODE = '23514';
  END IF;
  SELECT template_version_id INTO pinned_version FROM document_revisions
    WHERE document_id = NEW.document_id ORDER BY revision_number LIMIT 1;
  IF pinned_version IS NOT NULL AND NEW.template_version_id <> pinned_version THEN
    RAISE EXCEPTION 'Document template version is pinned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER document_revisions_pinned_version BEFORE INSERT ON document_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_document_revision_version();
