export const WORKBENCH_NOTIFICATION_KIND = {
  connectionDisconnected: "connection.disconnected",
  connectionReconnected: "connection.reconnected",
  workspaceLoadError: "workspace.loadError",
  /** Ephemeral editor messages (save, open, terminal, etc.). */
  editorNotice: "editor.notice",
  /** Save / don't save / cancel when closing dirty editors. */
  editorCloseConfirm: "editor.closeConfirm",
} as const;

export type WorkbenchNotificationKind =
  (typeof WORKBENCH_NOTIFICATION_KIND)[keyof typeof WORKBENCH_NOTIFICATION_KIND]
  | (string & {});

export type WorkbenchNotificationSeverity = "info" | "warning" | "error";

export type WorkbenchNotificationAction = {
  id: string;
  label: string;
  /** Primary = accent fill (VS Code primary button style). */
  primary?: boolean;
  onClick: () => void;
};

export type WorkbenchNotificationInput = {
  kind: WorkbenchNotificationKind;
  severity: WorkbenchNotificationSeverity;
  title: string;
  message: string;
  /** If true, no auto-dismiss timer. */
  persistent?: boolean;
  autoDismissMs?: number;
  actions?: WorkbenchNotificationAction[];
  /** Called when the toast is fully removed (after exit animation for dismiss). */
  onDismiss?: () => void;
};

export type WorkbenchNotificationItem = WorkbenchNotificationInput & {
  id: string;
  createdAt: number;
};
