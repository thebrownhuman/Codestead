"use client";

import { RotateCcw } from "lucide-react";

import { ReturnHomeLink, RouteState } from "@/components/shell/route-state";

export default function Error({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}) {
  return (
    <RouteState
      action={(
        <>
          <button className="button button-primary" onClick={reset} type="button">
            <RotateCcw aria-hidden="true" size={17} />
            Try this page again
          </button>
          <ReturnHomeLink />
        </>
      )}
      description="Codestead could not safely finish this page. Your persisted learning evidence has not been replaced or guessed."
      detail={error.digest ? `Error reference: ${error.digest}` : undefined}
      eyebrow="Route interrupted"
      standalone
      title="This step needs another run"
      variant="error"
    />
  );
}
