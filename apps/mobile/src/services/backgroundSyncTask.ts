export async function createBackgroundSyncTask(taskData?: { reason?: string }) {
  globalThis.__cesiumLastBackgroundSync = {
    reason: taskData?.reason ?? "background-sync",
    at: Date.now(),
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __cesiumLastBackgroundSync: { reason: string; at: number } | undefined;
  // eslint-disable-next-line no-var
  var __cesiumLastNotificationAction:
    | { actionId: string; notificationId: string | null; type: unknown }
    | undefined;
}
