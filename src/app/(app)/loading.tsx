import { RouteState } from "@/components/shell/route-state";

export default function LearnerLoading() {
  return (
    <RouteState
      description="Your saved progress stays in place while this route prepares its latest learning state."
      eyebrow="Loading checkpoint"
      title="Setting up your next step."
      variant="loading"
    />
  );
}
