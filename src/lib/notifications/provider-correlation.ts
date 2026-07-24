const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function outboxMessageId(operationId: string) {
  if (!UUID.test(operationId)) {
    throw new Error("Outbox operation ID must be a UUID.");
  }
  return `<codestead.outbox.${operationId.toLowerCase()}@mail.codestead.invalid>`;
}
