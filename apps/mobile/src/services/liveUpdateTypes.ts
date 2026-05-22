export type LiveUpdatePayload = {
  title: string;
  body: string;
  shortText: string;
  workspaceId?: string | null;
  conversationId?: string | null;
  startedAt?: number | null;
  progress?: number;
  progressMax?: number;
  indeterminate?: boolean;
  intervention?: "permission" | "question" | null;
  ongoing?: boolean;
  cancellable?: boolean;
};

export type LiveUpdateStatus = {
  sdkInt: number;
  progressStyleSupported: boolean;
  canPostPromotedNotifications: boolean;
  notificationPermissionGranted: boolean;
};
