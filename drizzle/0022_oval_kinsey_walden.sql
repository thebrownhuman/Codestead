CREATE TABLE "project_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"client_request_id" uuid NOT NULL,
	"input_hash" text NOT NULL,
	"change_summary" text NOT NULL,
	"reflection" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_revision_sequence_positive" CHECK ("project_revision"."sequence" >= 1),
	CONSTRAINT "project_revision_input_hash_shape" CHECK ("project_revision"."input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "project_revision_summary_length" CHECK (char_length("project_revision"."change_summary") BETWEEN 10 AND 1000),
	CONSTRAINT "project_revision_reflection_length" CHECK ("project_revision"."reflection" IS NULL OR char_length("project_revision"."reflection") BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE TABLE "project_revision_object" (
	"revision_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"object_id" uuid,
	"original_name" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_revision_object_revision_id_ordinal_pk" PRIMARY KEY("revision_id","ordinal"),
	CONSTRAINT "project_revision_object_ordinal_range" CHECK ("project_revision_object"."ordinal" BETWEEN 0 AND 19),
	CONSTRAINT "project_revision_object_name_length" CHECK (char_length("project_revision_object"."original_name") BETWEEN 1 AND 255),
	CONSTRAINT "project_revision_object_media_type_length" CHECK (char_length("project_revision_object"."media_type") BETWEEN 1 AND 120),
	CONSTRAINT "project_revision_object_size_nonnegative" CHECK ("project_revision_object"."size_bytes" >= 0),
	CONSTRAINT "project_revision_object_sha256_shape" CHECK ("project_revision_object"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "project_revision" ADD CONSTRAINT "project_revision_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_revision_object" ADD CONSTRAINT "project_revision_object_revision_id_project_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."project_revision"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_revision_object" ADD CONSTRAINT "project_revision_object_object_id_stored_object_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."stored_object"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_revision_project_sequence_unique" ON "project_revision" USING btree ("project_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "project_revision_request_unique" ON "project_revision" USING btree ("project_id","client_request_id");--> statement-breakpoint
CREATE INDEX "project_revision_project_created_idx" ON "project_revision" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_revision_object_revision_object_unique" ON "project_revision_object" USING btree ("revision_id","object_id");--> statement-breakpoint
CREATE INDEX "project_revision_object_object_idx" ON "project_revision_object" USING btree ("object_id");--> statement-breakpoint
CREATE FUNCTION reject_project_revision_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'project revision evidence is append-only' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE FUNCTION guard_project_revision_object_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD.revision_id = NEW.revision_id
		AND OLD.ordinal = NEW.ordinal
		AND OLD.object_id IS NOT NULL AND NEW.object_id IS NULL
		AND OLD.original_name IS NOT DISTINCT FROM NEW.original_name
		AND OLD.media_type IS NOT DISTINCT FROM NEW.media_type
		AND OLD.size_bytes IS NOT DISTINCT FROM NEW.size_bytes
		AND OLD.sha256 IS NOT DISTINCT FROM NEW.sha256
		AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at
	THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'project revision evidence is append-only' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "project_revision_append_only"
BEFORE UPDATE ON "project_revision"
FOR EACH ROW EXECUTE FUNCTION reject_project_revision_update();--> statement-breakpoint
CREATE TRIGGER "project_revision_object_append_only"
BEFORE UPDATE ON "project_revision_object"
FOR EACH ROW EXECUTE FUNCTION guard_project_revision_object_update();
