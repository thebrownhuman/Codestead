CREATE TABLE "runner_power_rehearsal_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"control_key" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'armed' NOT NULL,
	"actor_user_id" text NOT NULL,
	"learner_one_id" text NOT NULL,
	"learner_two_id" text NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"slot_one_request_id" text,
	"slot_one_submission_id" uuid,
	"slot_one_runner_job_id" uuid,
	"slot_two_request_id" text,
	"slot_two_submission_id" uuid,
	"slot_two_runner_job_id" uuid,
	"filled_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"aborted_at" timestamp with time zone,
	"terminal_command_id" uuid,
	"terminal_command_hash" char(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_power_rehearsal_control_key_check" CHECK ("runner_power_rehearsal_event"."control_key" = 1),
	CONSTRAINT "runner_power_rehearsal_state_check" CHECK ("runner_power_rehearsal_event"."state" in ('armed','filled','released','aborted')),
	CONSTRAINT "runner_power_rehearsal_distinct_learners_check" CHECK ("runner_power_rehearsal_event"."learner_one_id" <> "runner_power_rehearsal_event"."learner_two_id"),
	CONSTRAINT "runner_power_rehearsal_reason_length_check" CHECK (char_length("runner_power_rehearsal_event"."reason") between 20 and 500),
	CONSTRAINT "runner_power_rehearsal_expiry_window_check" CHECK ("runner_power_rehearsal_event"."expires_at" >= "runner_power_rehearsal_event"."created_at" + interval '5 minutes'
        and "runner_power_rehearsal_event"."expires_at" <= "runner_power_rehearsal_event"."created_at" + interval '120 minutes'),
	CONSTRAINT "runner_power_rehearsal_slot_one_atomic_check" CHECK (("runner_power_rehearsal_event"."slot_one_request_id" is null and "runner_power_rehearsal_event"."slot_one_submission_id" is null and "runner_power_rehearsal_event"."slot_one_runner_job_id" is null)
        or ("runner_power_rehearsal_event"."slot_one_request_id" is not null and "runner_power_rehearsal_event"."slot_one_submission_id" is not null and "runner_power_rehearsal_event"."slot_one_runner_job_id" is not null)),
	CONSTRAINT "runner_power_rehearsal_slot_two_atomic_check" CHECK (("runner_power_rehearsal_event"."slot_two_request_id" is null and "runner_power_rehearsal_event"."slot_two_submission_id" is null and "runner_power_rehearsal_event"."slot_two_runner_job_id" is null)
        or ("runner_power_rehearsal_event"."slot_two_request_id" is not null and "runner_power_rehearsal_event"."slot_two_submission_id" is not null and "runner_power_rehearsal_event"."slot_two_runner_job_id" is not null)),
	CONSTRAINT "runner_power_rehearsal_distinct_slots_check" CHECK ("runner_power_rehearsal_event"."slot_one_request_id" is null or "runner_power_rehearsal_event"."slot_two_request_id" is null or (
        "runner_power_rehearsal_event"."slot_one_request_id" <> "runner_power_rehearsal_event"."slot_two_request_id"
        and "runner_power_rehearsal_event"."slot_one_submission_id" <> "runner_power_rehearsal_event"."slot_two_submission_id"
        and "runner_power_rehearsal_event"."slot_one_runner_job_id" <> "runner_power_rehearsal_event"."slot_two_runner_job_id"
      )),
	CONSTRAINT "runner_power_rehearsal_request_one_shape_check" CHECK ("runner_power_rehearsal_event"."slot_one_request_id" is null or "runner_power_rehearsal_event"."slot_one_request_id" ~ '^[0-9a-fA-F-]{36}$'),
	CONSTRAINT "runner_power_rehearsal_request_two_shape_check" CHECK ("runner_power_rehearsal_event"."slot_two_request_id" is null or "runner_power_rehearsal_event"."slot_two_request_id" ~ '^[0-9a-fA-F-]{36}$'),
	CONSTRAINT "runner_power_rehearsal_filled_state_check" CHECK ("runner_power_rehearsal_event"."state" not in ('filled','released') or (
        "runner_power_rehearsal_event"."slot_one_request_id" is not null and "runner_power_rehearsal_event"."slot_two_request_id" is not null and "runner_power_rehearsal_event"."filled_at" is not null
      )),
	CONSTRAINT "runner_power_rehearsal_terminal_state_check" CHECK ((
        "runner_power_rehearsal_event"."state" in ('armed','filled') and "runner_power_rehearsal_event"."released_at" is null and "runner_power_rehearsal_event"."aborted_at" is null
          and "runner_power_rehearsal_event"."terminal_command_id" is null and "runner_power_rehearsal_event"."terminal_command_hash" is null
      ) or (
        "runner_power_rehearsal_event"."state" = 'released' and "runner_power_rehearsal_event"."released_at" is not null and "runner_power_rehearsal_event"."aborted_at" is null
          and "runner_power_rehearsal_event"."terminal_command_id" is not null and "runner_power_rehearsal_event"."terminal_command_hash" ~ '^[0-9a-f]{64}$'
      ) or (
        "runner_power_rehearsal_event"."state" = 'aborted' and "runner_power_rehearsal_event"."aborted_at" is not null and "runner_power_rehearsal_event"."released_at" is null
          and "runner_power_rehearsal_event"."terminal_command_id" is not null and "runner_power_rehearsal_event"."terminal_command_hash" ~ '^[0-9a-f]{64}$'
      ))
);
--> statement-breakpoint
ALTER TABLE "runner_power_rehearsal_event" ADD CONSTRAINT "runner_power_rehearsal_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_power_rehearsal_event" ADD CONSTRAINT "runner_power_rehearsal_event_learner_one_id_user_id_fk" FOREIGN KEY ("learner_one_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_power_rehearsal_event" ADD CONSTRAINT "runner_power_rehearsal_event_learner_two_id_user_id_fk" FOREIGN KEY ("learner_two_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_power_rehearsal_event" ADD CONSTRAINT "runner_power_rehearsal_event_slot_one_submission_id_code_submission_id_fk" FOREIGN KEY ("slot_one_submission_id") REFERENCES "public"."code_submission"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_power_rehearsal_event" ADD CONSTRAINT "runner_power_rehearsal_event_slot_one_runner_job_id_runner_job_id_fk" FOREIGN KEY ("slot_one_runner_job_id") REFERENCES "public"."runner_job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_power_rehearsal_event" ADD CONSTRAINT "runner_power_rehearsal_event_slot_two_submission_id_code_submission_id_fk" FOREIGN KEY ("slot_two_submission_id") REFERENCES "public"."code_submission"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_power_rehearsal_event" ADD CONSTRAINT "runner_power_rehearsal_event_slot_two_runner_job_id_runner_job_id_fk" FOREIGN KEY ("slot_two_runner_job_id") REFERENCES "public"."runner_job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runner_power_rehearsal_single_active_unique" ON "runner_power_rehearsal_event" USING btree ("control_key") WHERE "runner_power_rehearsal_event"."state" in ('armed','filled');--> statement-breakpoint
CREATE INDEX "runner_power_rehearsal_learner_one_idx" ON "runner_power_rehearsal_event" USING btree ("learner_one_id","created_at");--> statement-breakpoint
CREATE INDEX "runner_power_rehearsal_learner_two_idx" ON "runner_power_rehearsal_event" USING btree ("learner_two_id","created_at");