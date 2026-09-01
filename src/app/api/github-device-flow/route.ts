/**
 * GitHub OAuth device-flow relay for the browser machine.
 *
 * GitHub's device-flow endpoints (`/login/device/code` and
 * `/login/oauth/access_token`) do not send CORS headers, so a pure browser
 * client cannot complete sign-in on its own. This stateless same-origin
 * route relays exactly those two endpoints. No client secret is involved -
 * the device flow only needs a public client id.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DeviceFlowBody = {
  action?: "start" | "poll";
  clientId?: string;
  scope?: string;
  deviceCode?: string;
};

export async function POST(request: Request): Promise<Response> {
  let body: DeviceFlowBody;
  try {
    body = (await request.json()) as DeviceFlowBody;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const clientId = body.clientId?.trim();
  if (!clientId || !/^[A-Za-z0-9._-]{1,80}$/.test(clientId)) {
    return Response.json({ error: "Expected clientId." }, { status: 400 });
  }

  if (body.action === "start") {
    const upstream = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        scope: body.scope ?? "repo read:user",
      }),
    });
    return Response.json(await upstream.json(), {
      status: upstream.status,
      headers: { "Cache-Control": "no-store" },
    });
  }

  if (body.action === "poll") {
    const deviceCode = body.deviceCode?.trim();
    if (!deviceCode) {
      return Response.json({ error: "Expected deviceCode." }, { status: 400 });
    }
    const upstream = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    return Response.json(await upstream.json(), {
      status: upstream.status,
      headers: { "Cache-Control": "no-store" },
    });
  }

  return Response.json({ error: "Expected action 'start' or 'poll'." }, { status: 400 });
}
