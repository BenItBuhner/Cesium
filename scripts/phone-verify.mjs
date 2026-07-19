// Ad-hoc live verification harness for the phone-control MCP against the emulator.
const WS = "8af22c44f404";
const BASE = "http://127.0.0.1:9100";

async function call(toolName, args = {}) {
  const res = await fetch(`${BASE}/api/workspaces/${WS}/mcp/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-opencursor-workspace-id": WS },
    body: JSON.stringify({ serverId: "phone", toolName, arguments: args }),
  });
  const text = await res.text();
  if (!res.ok) return { httpError: res.status, body: text.slice(0, 400) };
  try {
    const outer = JSON.parse(text);
    const inner = JSON.parse(outer.result);
    return inner;
  } catch {
    return { parseError: true, body: text.slice(0, 400) };
  }
}

function trimImg(obj) {
  return JSON.stringify(obj, (k, v) => {
    if ((k === "imageDataUrl") && typeof v === "string") return `<jpeg ${v.length} chars>`;
    if (k === "nodes" && Array.isArray(v)) return `<${v.length} nodes>`;
    if (k === "apps" && Array.isArray(v)) return `<${v.length} apps>`;
    return v;
  });
}

const steps = JSON.parse(process.argv[2] || "[]");
for (const [tool, args, label] of steps) {
  const r = await call(tool, args);
  const ok = r.ok !== false && !r.httpError && !r.parseError;
  console.log(`\n### ${label || tool} => ${ok ? "OK" : "FAIL"}`);
  console.log(trimImg(r.result ?? r).slice(0, 900));
}
