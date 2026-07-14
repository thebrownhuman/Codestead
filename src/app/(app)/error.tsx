"use client";

import { RefreshCcw } from "lucide-react";

import { ReturnHomeLink, RouteState } from "@/components/shell/route-state";

export default function LearnerError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteState
      action={
        <>
          <button className="button button-primary" onClick={reset} type="button">
            <RefreshCcw aria-hidden="true" size={17} />
            Try this page again
          </button>
          <ReturnHomeLink />
        </>
      }
      description="This page could not finish loading. Try it again; if the problem continues, return home and keep learning from another checkpoint."
      detail={error.digest ? `Reference ${error.digest}` : undefined}
      eyebrow="Route interrupted"
      title="This checkpoint needs another run."
      variant="error"
    />
  );
}
