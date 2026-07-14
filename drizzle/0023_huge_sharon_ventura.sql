CREATE TABLE "practice_help_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"step" integer NOT NULL,
	"kind" text NOT NULL,
	"assistance_level" text NOT NULL,
	"solution_revealed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practice_help_event_step_check" CHECK ("practice_help_event"."step" > 0 and "practice_help_event"."step" <= 64),
	CONSTRAINT "practice_help_event_kind_check" CHECK ("practice_help_event"."kind" in ('hint', 'alternate', 'example', 'solution')),
	CONSTRAINT "practice_help_event_assistance_check" CHECK ("practice_help_event"."assistance_level" in ('A1', 'A2', 'A3', 'A4')),
	CONSTRAINT "practice_help_event_solution_check" CHECK (("practice_help_event"."kind" = 'solution') = "practice_help_event"."solution_revealed")
);
--> statement-breakpoint
ALTER TABLE "attempt" ADD COLUMN "assistance_level" text DEFAULT 'A0' NOT NULL;--> statement-breakpoint
ALTER TABLE "attempt" ADD COLUMN "solution_revealed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "attempt" ADD COLUMN "help_step" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "practice_help_event" ADD CONSTRAINT "practice_help_event_attempt_id_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempt"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_help_event" ADD CONSTRAINT "practice_help_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "practice_help_event_user_request_unique" ON "practice_help_event" USING btree ("user_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "practice_help_event_attempt_step_unique" ON "practice_help_event" USING btree ("attempt_id","step");--> statement-breakpoint
CREATE INDEX "practice_help_event_user_time_idx" ON "practice_help_event" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_assistance_level_check" CHECK ("attempt"."assistance_level" in ('A0', 'A1', 'A2', 'A3', 'A4'));--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_help_step_check" CHECK ("attempt"."help_step" >= 0 and "attempt"."help_step" <= 64);--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_solution_assistance_check" CHECK (not "attempt"."solution_revealed" or "attempt"."assistance_level" = 'A4');