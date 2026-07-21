export type LiveUpdatePayload = {
  runKey: string;
  title: string;
  body: string;
  shortText?: string | null;
  workspaceId?: string | null;
  conversationId?: string | null;
  startedAt?: number | null;
  estimatedCompletionAt?: number | null;
  progressKind: "todo" | "burn" | "indeterminate" | "terminal";
  progressLabel?: string | null;
  progress?: number;
  progressMax?: number;
  indeterminate?: boolean;
  todoCompleted?: number;
  todoTotal?: number;
  todoCurrentIndex?: number | null;
  burnProgressPercent?: number;
  estimatedRemainingSeconds?: number | null;
  intervention?: "permission" | "question" | null;
  ongoing?: boolean;
  cancellable?: boolean;
  promote?: boolean;
};

export type LiveUpdateStatus = {
  sdkInt: number;
  progressStyleSupported: boolean;
  canPostPromotedNotifications: boolean;
  notificationPermissionGranted: boolean;
  suppressedByDismissal: boolean;
  deliveryPreference: "nowbar" | "live" | "off";
};
