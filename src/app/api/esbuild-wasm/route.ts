/**
 * Serve the esbuild-wasm binary same-origin for the Browser Machine so
 * in-browser builds work even when third-party CDNs are unreachable
 * (locked-down networks, offline-ish PWA sessions). Falls back to a CDN
 * redirect if the local module cannot be read.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-static";

const ESBUILD_VERSION = "0.27.7";

export async function GET(): Promise<Response> {
  try {
    // Runtime-computed path so the bundler does not try to process the wasm.
    const wasmPath = join(process.cwd(), "node_modules", "esbuild-wasm", "esbuild.wasm");
    const bytes = await readFile(wasmPath);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/wasm",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return Response.redirect(
      `https://cdn.jsdelivr.net/npm/esbuild-wasm@${ESBUILD_VERSION}/esbuild.wasm`,
      302
    );
  }
}
