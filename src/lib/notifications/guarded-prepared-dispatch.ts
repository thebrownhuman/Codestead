import {
  createMaterializedDispatch,
} from "./prepared-dispatch-materialization";
import {
  captureMailTransportConfiguration,
} from "./mailer-transport-internal";

export function createConfiguredMaterializedDispatch(
  input: Omit<
    Parameters<typeof createMaterializedDispatch>[0],
    "transportConfiguration"
  >,
) {
  return createMaterializedDispatch({
    ...input,
    transportConfiguration: captureMailTransportConfiguration(input.adapter),
  });
}

export {
  materializedDispatchEnvelope,
  preparedDispatchStoreView,
} from "./prepared-dispatch-materialization";
export type {
  GuardedPreparedDispatch,
  MaterializedDispatch,
  PreparedDispatchDelivery,
  PreparedDispatchEnvelope,
  PreparedDispatchRuntimePlan,
  PreparedDispatchSource,
  PreparedDispatchStoreInspection,
  PreparedDispatchStoreView,
} from "./prepared-dispatch-materialization";
