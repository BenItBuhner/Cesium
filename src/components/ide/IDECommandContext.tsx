"use client";

import {
  createContext,
  useContext,
  type ReactNode,
} from "react";

export type IDECommandRunner = (id: string) => void;

const IDECommandContext = createContext<IDECommandRunner | null>(null);

export function IDECommandProvider({
  value,
  children,
}: {
  value: IDECommandRunner;
  children: ReactNode;
}) {
  return (
    <IDECommandContext.Provider value={value}>
      {children}
    </IDECommandContext.Provider>
  );
}

/** Returns null when used outside the IDE shell (e.g. isolated tests). */
export function useIDECommandRunner(): IDECommandRunner | null {
  return useContext(IDECommandContext);
}
