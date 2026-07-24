REVOKE ALL ON TABLE public.email_outbox FROM learncoding_worker;--> statement-breakpoint
REVOKE ALL (
  id, user_id, to_email, template, template_version, variables,
  idempotency_key, operation_id, delivery_scope_key, status, attempt_count,
  claim_token, claim_owner, claim_version, lease_expires_at,
  provider_call_started, adapter, provider_message_id, next_attempt_at,
  sent_at, quarantined_at, last_error_code, created_at, updated_at
) ON TABLE public.email_outbox FROM learncoding_worker;--> statement-breakpoint
GRANT SELECT ON TABLE public.email_outbox TO learncoding_worker;--> statement-breakpoint
GRANT INSERT (
  operation_id, user_id, delivery_scope_key, to_email, template,
  template_version, variables, idempotency_key, status, next_attempt_at
) ON TABLE public.email_outbox TO learncoding_worker;--> statement-breakpoint
GRANT UPDATE (
  status, attempt_count, claim_token, claim_owner, claim_version,
  lease_expires_at, provider_call_started, adapter, provider_message_id,
  next_attempt_at, sent_at, quarantined_at, last_error_code, updated_at
) ON TABLE public.email_outbox TO learncoding_worker;
