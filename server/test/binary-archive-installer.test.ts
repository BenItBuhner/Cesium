import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

const TEST_ROOT = path.join(os.tmpdir(), `binary-archive-${process.pid}-${Date.now()}`);
mkdirSync(TEST_ROOT, { recursive: true });
process.env.OPENCURSOR_DATA_DIR = path.join(TEST_ROOT, "data");

type ZipInput = { name: string; data?: Buffer; mode?: number; store?: boolean };

/** Minimal ZIP writer (deflate/store, Unix mode bits) for installer tests. */
function buildZip(entries: ZipInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const isDir = entry.name.endsWith("/");
    const data = isDir ? Buffer.alloc(0) : entry.data ?? Buffer.alloc(0);
    const compressed = entry.store || isDir ? data : deflateRawSync(data);
    const method = entry.store || isDir ? 0 : 8;
    const name = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by: Unix (3), spec 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    const mode = entry.mode ?? (isDir ? 0o755 : 0o644);
    central.writeUInt32LE(((isDir ? 0o040000 : 0o100000) | mode) << 16 >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function tempDir(label: string): string {
  const dir = path.join(TEST_ROOT, `${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const FAKE_SERVER_SCRIPT = "#!/bin/sh\necho fake\n";

test("registry manifest parsing, platform keys, and host support", async () => {
  const reg = await import("../src/lib/agents/install/cli-install-registry.js");
  const installer = await import("../src/lib/agents/install/binary-archive-installer.js");
  assert.equal(reg.acpRegistryPlatformKey("linux", "x64"), "linux-x86_64");
  assert.equal(reg.acpRegistryPlatformKey("linux", "arm64"), "linux-aarch64");
  assert.equal(reg.acpRegistryPlatformKey("darwin", "arm64"), "darwin-aarch64");
  assert.equal(reg.acpRegistryPlatformKey("win32", "x64"), "windows-x86_64");
  assert.equal(reg.acpRegistryPlatformKey("freebsd", "x64"), null);
  const spec = reg.getInstallSpecForBackend("google-antigravity-acp");
  assert.ok(spec && spec.kind === "binary-archive");
  assert.equal(reg.isInstallSupportedOnThisHost(spec, "linux", "x64"), true);
  assert.equal(reg.isInstallSupportedOnThisHost(spec, "darwin", "arm64"), true);
  // Google ships no Intel macOS build.
  assert.equal(reg.isInstallSupportedOnThisHost(spec, "darwin", "x64"), false);

  assert.equal(installer.parseAcpRegistryManifest({ id: "x" }), null);
  assert.equal(
    installer.parseAcpRegistryManifest({
      id: "antigravity-acp",
      name: "Google Antigravity",
      version: "1.1.1",
      distribution: { binary: { "linux-x86_64": { cmd: "./x" } } },
    }),
    null,
    "binary targets need an archive URL"
  );
  const parsed = installer.parseAcpRegistryManifest({
    id: "antigravity-acp",
    name: "Google Antigravity",
    version: " 1.2.0 ",
    authors: ["Google LLC", 42],
    distribution: {
      binary: { "linux-x86_64": { archive: "https://dl.google.com/x.zip", cmd: "./agy_acp_server.par", args: ["--uid="] } },
    },
  });
  assert.equal(parsed?.version, "1.2.0");
  assert.deepEqual(parsed?.authors, ["Google LLC"]);
  assert.deepEqual(parsed?.distribution.binary?.["linux-x86_64"]?.args, ["--uid="]);
});

test("manifest fetch falls back to the pinned copy on network/shape failures", async () => {
  const reg = await import("../src/lib/agents/install/cli-install-registry.js");
  const installer = await import("../src/lib/agents/install/binary-archive-installer.js");
  const spec = reg.getInstallSpecForBackend("google-antigravity-acp");
  assert.ok(spec && spec.kind === "binary-archive");

  const failing = await installer.fetchAcpRegistryManifest(spec, {
    fetchImpl: (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch,
  });
  assert.equal(failing.source, "fallback");
  assert.equal(failing.manifest.version, "1.1.1");
  assert.match(failing.error ?? "", /offline/);

  const wrongAgent = await installer.fetchAcpRegistryManifest(spec, {
    fetchImpl: (async () =>
      new Response(JSON.stringify({ id: "claude-acp", name: "x", version: "9", distribution: {} }), {
        status: 200,
      })) as unknown as typeof fetch,
  });
  assert.equal(wrongAgent.source, "fallback");

  const live = await installer.fetchAcpRegistryManifest(spec, {
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          ...spec.fallbackManifest,
          version: "1.1.2",
        }),
        { status: 200 }
      )) as unknown as typeof fetch,
  });
  assert.equal(live.source, "registry");
  assert.equal(live.manifest.version, "1.1.2");
});

test("streaming zip extractor writes nested entries, keeps exec bits, refuses traversal", async () => {
  const zipMod = await import("../src/lib/agents/install/zip-stream.js");
  const dir = tempDir("zip");
  const archive = path.join(dir, "a.zip");
  const big = Buffer.alloc(3 * 1024 * 1024, 0x41);
  writeFileSync(
    archive,
    buildZip([
      { name: "bin/" },
      { name: "bin/agy_acp_server.par", data: Buffer.from(FAKE_SERVER_SCRIPT), mode: 0o755 },
      { name: "bin/localharness_external", data: big, mode: 0o555 },
      { name: "README.txt", data: Buffer.from("hello"), store: true },
    ])
  );
  const entries = await zipMod.readStreamZipEntries(archive, { maxEntries: 100, maxUncompressedBytes: 64 * 1024 * 1024 });
  assert.deepEqual(entries.map((entry) => entry.name), ["bin/", "bin/agy_acp_server.par", "bin/localharness_external", "README.txt"]);
  assert.equal(entries[1]?.unixMode, 0o755);
  const progress: number[] = [];
  const out = path.join(dir, "out");
  await zipMod.extractStreamZip(archive, out, {
    limits: { maxEntries: 100, maxUncompressedBytes: 64 * 1024 * 1024 },
    onProgress: ({ writtenBytes }) => progress.push(writtenBytes),
  });
  assert.equal(readFileSync(path.join(out, "bin", "agy_acp_server.par"), "utf8"), FAKE_SERVER_SCRIPT);
  assert.equal(statSync(path.join(out, "bin", "localharness_external")).size, big.length);
  assert.equal(readFileSync(path.join(out, "README.txt"), "utf8"), "hello");
  if (process.platform !== "win32") {
    assert.equal(statSync(path.join(out, "bin", "agy_acp_server.par")).mode & 0o777, 0o755);
  }
  assert.equal(progress[progress.length - 1], big.length + FAKE_SERVER_SCRIPT.length + 5);

  const evil = path.join(dir, "evil.zip");
  writeFileSync(evil, buildZip([{ name: "../escape.txt", data: Buffer.from("x") }]));
  await assert.rejects(
    zipMod.readStreamZipEntries(evil, { maxEntries: 10, maxUncompressedBytes: 1024 }),
    /unsafe entry path/
  );
  const tooBig = path.join(dir, "big.zip");
  writeFileSync(tooBig, buildZip([{ name: "x.bin", data: Buffer.alloc(2048, 1) }]));
  await assert.rejects(
    zipMod.readStreamZipEntries(tooBig, { maxEntries: 10, maxUncompressedBytes: 1024 }),
    /extracted size limit/
  );
});

test("binary-archive install downloads, extracts, points `current`, and is detected by the runtime", async () => {
  const reg = await import("../src/lib/agents/install/cli-install-registry.js");
  const installer = await import("../src/lib/agents/install/binary-archive-installer.js");
  const rt = await import("../src/lib/agents/harness-runtime.js");
  const spec = reg.getInstallSpecForBackend("google-antigravity-acp");
  assert.ok(spec && spec.kind === "binary-archive");

  const zip = buildZip([
    { name: "agy_acp_server.par", data: Buffer.from(FAKE_SERVER_SCRIPT), mode: 0o755 },
    { name: "localharness_external", data: Buffer.alloc(4096, 7), mode: 0o555 },
  ]);
  const manifest = {
    ...spec.fallbackManifest,
    version: "1.1.9",
    distribution: {
      binary: {
        "linux-x86_64": { archive: "https://dl.google.com/agy-extensions/test-linux.zip", cmd: "./agy_acp_server.par", args: ["--uid="] },
        "darwin-aarch64": { archive: "https://dl.google.com/agy-extensions/test-mac.zip", cmd: "./agy_acp_server.par" },
        "windows-x86_64": { archive: "https://dl.google.com/agy-extensions/test-win.zip", cmd: "./agy_acp_server.exe" },
      },
    },
  };
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    requested.push(url);
    if (url === spec.manifestUrl) {
      return new Response(JSON.stringify(manifest), { status: 200 });
    }
    if (url.endsWith("test-linux.zip")) {
      return new Response(zip, { status: 200, headers: { "content-length": String(zip.length) } });
    }
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;

  const events: Array<Record<string, unknown>> = [];
  const result = await installer.installBinaryArchive(spec, {
    fetchImpl,
    platform: "linux",
    arch: "x64",
    skipDiskCheck: true,
    emit: (event) => events.push(event as unknown as Record<string, unknown>),
  });
  assert.equal(result.version, "1.1.9");
  assert.equal(result.manifestSource, "registry");
  assert.equal(result.skippedDownload, false);
  assert.deepEqual(result.args, ["--uid="]);
  assert.equal(result.executablePath, path.join(reg.binaryArchiveVersionDir("antigravity-acp", "1.1.9"), "agy_acp_server.par"));
  assert.ok(rt.isExecutableFile(result.executablePath));
  assert.ok(existsSync(path.join(result.installDir, "cesium-install.json")));
  assert.equal(reg.binaryArchiveCurrentDir("antigravity-acp"), path.join(reg.binaryArchiveInstallRoot("antigravity-acp"), "current"));
  assert.equal(
    await fs.realpath(reg.binaryArchiveCurrentDir("antigravity-acp")),
    await fs.realpath(result.installDir)
  );
  const pointer = JSON.parse(readFileSync(reg.binaryArchiveCurrentPointerPath("antigravity-acp"), "utf8"));
  assert.equal(pointer.version, "1.1.9");
  const phases = events.filter((event) => event.type === "progress").map((event) => event.phase);
  assert.ok(phases.includes("download") && phases.includes("extract") && phases.includes("finalize"));
  assert.ok(events.some((event) => event.type === "log" && /installed at/.test(String(event.line))));
  assert.equal(requested.filter((url) => url.endsWith(".zip")).length, 1);
  // No temp residue.
  const leftovers = (await fs.readdir(reg.binaryArchiveInstallRoot("antigravity-acp"))).filter((name) => name.startsWith(".tmp-"));
  assert.deepEqual(leftovers, []);

  // Second run for the same version only refreshes the pointer.
  const again = await installer.installBinaryArchive(spec, {
    fetchImpl,
    platform: "linux",
    arch: "x64",
    skipDiskCheck: true,
  });
  assert.equal(again.skippedDownload, true);
  assert.equal(requested.filter((url) => url.endsWith(".zip")).length, 1);
  assert.deepEqual(
    (await installer.listInstalledBinaryArchiveVersions(spec)).map((entry) => entry.version),
    ["1.1.9"]
  );

  // Runtime detection finds the Cesium-managed install without env overrides.
  const previousBin = process.env.OPENCURSOR_ANTIGRAVITY_ACP_BIN;
  const previousXdg = process.env.XDG_DATA_HOME;
  delete process.env.OPENCURSOR_ANTIGRAVITY_ACP_BIN;
  process.env.XDG_DATA_HOME = tempDir("xdg-empty");
  try {
    rt.resetHarnessRuntimeCachesForTest();
    const detection = rt.detectHarnessCli("google-antigravity-acp");
    assert.equal(detection?.source, "well-known");
    assert.equal(detection?.executablePath, path.join(reg.binaryArchiveCurrentDir("antigravity-acp"), "agy_acp_server.par"));
  } finally {
    if (previousBin === undefined) delete process.env.OPENCURSOR_ANTIGRAVITY_ACP_BIN;
    else process.env.OPENCURSOR_ANTIGRAVITY_ACP_BIN = previousBin;
    if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdg;
    rt.resetHarnessRuntimeCachesForTest();
  }

  // Unsupported host and disallowed archive hosts are refused before download.
  await assert.rejects(
    installer.installBinaryArchive(spec, { fetchImpl, platform: "darwin", arch: "x64", skipDiskCheck: true }),
    /no build for darwin\/x64/
  );
  const hostileManifest = {
    ...manifest,
    version: "2.0.0",
    distribution: { binary: { "linux-x86_64": { archive: "https://evil.example/agy.zip", cmd: "./agy_acp_server.par" } } },
  };
  await assert.rejects(
    installer.installBinaryArchive(spec, {
      fetchImpl: (async () => new Response(JSON.stringify(hostileManifest), { status: 200 })) as unknown as typeof fetch,
      platform: "linux",
      arch: "x64",
      skipDiskCheck: true,
    }),
    /Refusing archive host evil\.example/
  );
});
