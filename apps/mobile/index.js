import { registerRootComponent } from "expo";
import { ExpoRoot } from "expo-router";

export function App() {
  const context = require.context("./src/app");
  return <ExpoRoot context={context} />;
}

registerRootComponent(App);
