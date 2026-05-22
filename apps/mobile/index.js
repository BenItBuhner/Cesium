import { AppRegistry } from "react-native";
import notifee from "@notifee/react-native";
import App from "./src/App";
import { name as appName } from "./app.json";
import { createBackgroundSyncTask } from "./src/services/backgroundSyncTask";

notifee.onBackgroundEvent(async ({ detail, type }) => {
  const actionId = detail.pressAction?.id ?? "default";
  globalThis.__cesiumLastNotificationAction = {
    actionId,
    notificationId: detail.notification?.id ?? null,
    type,
  };
});

AppRegistry.registerHeadlessTask("CesiumBackgroundSync", () => createBackgroundSyncTask);
AppRegistry.registerComponent(appName, () => App);
