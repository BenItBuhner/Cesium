export const CESIUM_SERVER_INSTALLER_URL =
  "https://raw.githubusercontent.com/BenItBuhner/Cesium/main/scripts/install-cesium-server.sh";

function shellSingleQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export function normalizeWebAppOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Cesium web URL must use http or https.");
  }
  return url.origin;
}

export function buildCesiumServerInstallCommand(webAppUrl: string): string {
  const origin = normalizeWebAppOrigin(webAppUrl);
  return `curl -fsSL ${CESIUM_SERVER_INSTALLER_URL} | env CESIUM_WEB_URL=${shellSingleQuote(origin)} bash`;
}
