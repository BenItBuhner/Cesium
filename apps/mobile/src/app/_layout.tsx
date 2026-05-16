import { getTokens } from "@cesium/design";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useColorScheme } from "react-native";

export default function RootLayout() {
  const scheme = useColorScheme() === "light" ? "light" : "dark";
  const tokens = getTokens(scheme);

  return (
    <>
      <StatusBar hidden />
      <Stack
        screenOptions={{
          animation: "fade",
          contentStyle: { backgroundColor: tokens.color.bgMain },
          headerShown: false,
        }}
      />
    </>
  );
}
