import { RouteState } from "@/components/shell/route-state";

export default function Loading() {
  return (
    <RouteState
      description="Your saved work remains in place while Codestead prepares the next view."
      eyebrow="Loading your route"
      standalone
      title="Preparing your next useful step"
      variant="loading"
    />
  );
}
