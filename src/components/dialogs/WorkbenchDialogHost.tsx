"use client";

import { useContext } from "react";
import { WorkbenchDialog } from "@/components/dialogs/WorkbenchDialog";
import { WorkbenchDialogContext } from "@/components/dialogs/workbench-dialog-context";

/** Renders the active dialog request, one at a time, keyed per request. */
export function WorkbenchDialogHost() {
  const ctx = useContext(WorkbenchDialogContext);
  if (!ctx || !ctx.active) {
    return null;
  }
  return <WorkbenchDialog key={ctx.active.id} request={ctx.active} onSettle={ctx.settle} />;
}
