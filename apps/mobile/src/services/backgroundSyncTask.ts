export async function createBackgroundSyncTask(taskData?: { reason?: string }) {
  globalThis.__cesiumLastBackgroundSync = {
    reason: taskData?.reason ?? "background-sync",
    at: Date.now(),
  };
}

declare global {
  var __cesiumLastBackgroundSync: { reason: string; at: number } | undefined;
  var __cesiumLastNotificationAction:
    | { actionId: string; notificationId: string | null; type: unknown }
    | undefined;
}
