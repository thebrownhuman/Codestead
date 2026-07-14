import { ReturnHomeLink, RouteState } from "@/components/shell/route-state";

export default function LearnerNotFound() {
  return (
    <RouteState
      action={<ReturnHomeLink label="Back to learning home" />}
      description="This course, project, or checkpoint is no longer available at this address. Your saved learning evidence has not changed."
      eyebrow="Checkpoint not found"
      title="This route does not have that learning step."
      variant="not-found"
    />
  );
}
