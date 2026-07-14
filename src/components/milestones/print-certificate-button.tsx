"use client";

import { Printer } from "lucide-react";

export function PrintCertificateButton() {
  return <button className="button button-primary" onClick={() => window.print()} type="button"><Printer aria-hidden="true" size={16} /> Print certificate</button>;
}
