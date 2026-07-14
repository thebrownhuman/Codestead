"use client";

import { createContext, useContext, type ReactNode } from "react";

const DraftCacheNamespaceContext = createContext<string | null>(null);

export function DraftCacheNamespaceProvider({
  namespace,
  children,
}: {
  namespace: string | null;
  children: ReactNode;
}) {
  return (
    <DraftCacheNamespaceContext.Provider value={namespace}>
      {children}
    </DraftCacheNamespaceContext.Provider>
  );
}

export function useDraftCacheNamespace() {
  return useContext(DraftCacheNamespaceContext);
}
