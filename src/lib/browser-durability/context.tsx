"use client";

import { createContext, useContext, type ReactNode } from "react";

const BrowserDurabilityNamespaceContext = createContext<string | null>(null);

export function BrowserDurabilityNamespaceProvider({
  namespace,
  children,
}: {
  namespace: string | null;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <BrowserDurabilityNamespaceContext.Provider value={namespace}>
      {children}
    </BrowserDurabilityNamespaceContext.Provider>
  );
}

export function useBrowserDurabilityNamespace() {
  return useContext(BrowserDurabilityNamespaceContext);
}
