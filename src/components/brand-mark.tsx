import { Braces } from "lucide-react";

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand-mark" aria-label="Codestead" role="img">
      <span className="brand-mark__icon" aria-hidden="true">
        <Braces size={19} strokeWidth={2.4} />
      </span>
      {!compact && <span>Codestead</span>}
    </span>
  );
}
