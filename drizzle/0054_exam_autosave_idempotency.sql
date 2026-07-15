CREATE TABLE "exam_autosave_mutation" (
	"exam_session_id" uuid NOT NULL,
	"client_mutation_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"input_hash" char(64) NOT NULL,
	"expected_revision" integer NOT NULL,
	"resulting_revision" integer NOT NULL,
	"resulting_saved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_autosave_mutation_pk" PRIMARY KEY("exam_session_id","client_mutation_id"),
	CONSTRAINT "exam_autosave_mutation_input_hash_check" CHECK ("exam_autosave_mutation"."input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "exam_autosave_mutation_expected_revision_nonnegative" CHECK ("exam_autosave_mutation"."expected_revision" >= 0),
	CONSTRAINT "exam_autosave_mutation_resulting_revision_nonnegative" CHECK ("exam_autosave_mutation"."resulting_revision" >= 0),
	CONSTRAINT "exam_autosave_mutation_revision_transition" CHECK ("exam_autosave_mutation"."resulting_revision" = "exam_autosave_mutation"."expected_revision" + 1)
);
--> statement-breakpoint
ALTER TABLE "exam_autosave_mutation" ADD CONSTRAINT "exam_autosave_mutation_exam_session_id_exam_session_id_fk" FOREIGN KEY ("exam_session_id") REFERENCES "public"."exam_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exam_autosave_mutation_session_item_created_idx" ON "exam_autosave_mutation" USING btree ("exam_session_id","item_key","created_at");