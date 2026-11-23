CREATE TABLE "document_serial_counters" (
	"year" integer PRIMARY KEY,
	"last_value" integer NOT NULL,
	CONSTRAINT "document_serial_counters_year" CHECK ("year" between 1 and 9999),
	CONSTRAINT "document_serial_counters_range" CHECK ("last_value" between 1 and 9999)
);
--> statement-breakpoint
CREATE TABLE "expenditure_classifications" (
	"code" varchar(8) PRIMARY KEY,
	"name" varchar(255) NOT NULL,
	"kind" varchar(8) NOT NULL,
	CONSTRAINT "expenditure_classifications_kind" CHECK ("kind" in ('class', 'grouping'))
);
--> statement-breakpoint
CREATE TABLE "funds" (
	"code" varchar(3) PRIMARY KEY,
	"name" varchar(255) NOT NULL,
	CONSTRAINT "funds_code_format" CHECK ("code" ~ '^[0-9]{3}$')
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "serial_number" varchar(14);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "serial_fund_code" varchar(3);--> statement-breakpoint
ALTER TABLE "offices" ADD COLUMN "parent_office_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_serial_number_key" UNIQUE("serial_number");--> statement-breakpoint
CREATE INDEX "documents_serial_fund_idx" ON "documents" ("serial_fund_code") WHERE "serial_fund_code" is not null;--> statement-breakpoint
CREATE INDEX "offices_parent_office_idx" ON "offices" ("parent_office_id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_serial_fund_code_funds_code_fkey" FOREIGN KEY ("serial_fund_code") REFERENCES "funds"("code");--> statement-breakpoint
ALTER TABLE "offices" ADD CONSTRAINT "offices_parent_office_id_offices_id_fkey" FOREIGN KEY ("parent_office_id") REFERENCES "offices"("id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_serial_format" CHECK (("serial_number" is null and "serial_fund_code" is null) or (
      "serial_number" is not null and "serial_fund_code" is not null and
      "serial_number" ~ '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}-[0-9]{3}$' and
      left("serial_number", 4) <> '0000' and right("serial_number", 3) = "serial_fund_code"));--> statement-breakpoint
ALTER TABLE "offices" ADD CONSTRAINT "offices_parent_not_self" CHECK ("parent_office_id" <> "id");