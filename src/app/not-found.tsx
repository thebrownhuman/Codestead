import { ReturnHomeLink, RouteState } from "@/components/shell/route-state";

export default function NotFound() {
  return (
    <RouteState
      action={<ReturnHomeLink />}
      description="The address may be old, private, or mistyped. No learning progress was changed."
      eyebrow="Path not found"
      standalone
      title="There is no checkpoint here"
      variant="not-found"
    />
  );
}
