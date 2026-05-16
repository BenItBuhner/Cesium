/**
 * CLI: copy all data from one storage driver to another.
 *
 * Usage:
 *   node --import tsx scripts/storage-migrate.ts --from legacy-json --to pg
 *   node --import tsx scripts/storage-migrate.ts --from pg --to legacy-json --overwrite
 *   node --import tsx scripts/storage-migrate.ts --stats              # counts per driver
 *   node --import tsx scripts/storage-migrate.ts --phase workspaces --phase agent-events
 *
 * Environment: honours DATABASE_URL / OPENCURSOR_DATA_DIR for the respective
 * drivers. REDIS_URL is ignored — migration talks directly to the storage
 * driver, never through cache layers.
 */

import {
  ALL_MIGRATION_PHASES,
  gatherStats,
  migrate,
  openDriver,
  type MigrationPhase,
  type MigrationProgressEvent,
} from "../src/storage/migrate.js";
import type { StorageDriverKind } from "../src/storage/driver.js";

type Args = {
  from?: StorageDriverKind;
  to?: StorageDriverKind;
  overwrite: boolean;
  phases: MigrationPhase[];
  stats: boolean;
  quiet: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    overwrite: false,
    phases: [],
    stats: false,
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    switch (key) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--from":
        args.from = argv[++i] as StorageDriverKind;
        break;
      case "--to":
        args.to = argv[++i] as StorageDriverKind;
        break;
      case "--overwrite":
        args.overwrite = true;
        break;
      case "--phase":
        args.phases.push(argv[++i] as MigrationPhase);
        break;
      case "--stats":
        args.stats = true;
        break;
      case "--quiet":
        args.quiet = true;
        break;
      default:
        if (key.startsWith("--")) {
          console.error(`Unknown flag: ${key}`);
          process.exit(2);
        }
    }
  }
  return args;
}

function printHelp(): void {
  console.log(
    [
      "storage-migrate - copy data between Cesium storage drivers",
      "",
      "  --from <driver>      source driver (legacy-json | pg)",
      "  --to <driver>        target driver (legacy-json | pg)",
      "  --overwrite          overwrite rows that already exist on the target",
      "  --phase <name>       restrict to a phase (repeat for multiple)",
      "  --stats              print counts for each driver and exit",
      "  --quiet              suppress progress logging",
      "  --help / -h          show this message",
      "",
      "Phases (in order):",
      ...ALL_MIGRATION_PHASES.map((p) => `  - ${p}`),
    ].join("\n")
  );
}

function validateDriver(value: string | undefined, label: string): StorageDriverKind {
  if (value !== "legacy-json" && value !== "pg") {
    console.error(`${label} must be 'legacy-json' or 'pg' (got: ${value ?? "none"})`);
    process.exit(2);
  }
  return value;
}

async function runStats(): Promise<void> {
  for (const kind of ["legacy-json", "pg"] as const) {
    try {
      const driver = await openDriver(kind);
      try {
        const stats = await gatherStats(driver);
        console.log(`[${kind}]`, JSON.stringify(stats, null, 2));
      } finally {
        await driver.close().catch(() => {});
      }
    } catch (error) {
      console.error(`[${kind}] stats failed:`, (error as Error).message);
    }
  }
}

function formatProgress(event: MigrationProgressEvent): string {
  const total = event.total === null ? "?" : String(event.total);
  const key = event.currentKey ? ` ${event.currentKey}` : "";
  return `  [${event.phase}] ${event.completed}/${total}${key}`;
}

async function run(args: Args): Promise<void> {
  const from = validateDriver(args.from, "--from");
  const to = validateDriver(args.to, "--to");
  if (from === to) {
    console.error("--from and --to must differ");
    process.exit(2);
  }
  const phases = args.phases.length > 0 ? args.phases : undefined;
  console.log(
    `Migrating ${from} -> ${to}${args.overwrite ? " (overwrite)" : ""}${
      phases ? ` phases=${phases.join(",")}` : ""
    }`
  );
  let lastPhase: MigrationPhase | null = null;
  let lastPrint = 0;
  const result = await migrate({
    from,
    to,
    overwrite: args.overwrite,
    phases,
    onProgress: (event) => {
      if (args.quiet) return;
      const now = Date.now();
      const throttle = 200;
      if (event.phase !== lastPhase) {
        console.log(`-> ${event.phase}`);
        lastPhase = event.phase;
        lastPrint = 0;
      }
      if (now - lastPrint < throttle) return;
      lastPrint = now;
      console.log(formatProgress(event));
    },
  });

  for (const phase of result.phases) {
    const errCount = phase.errors.length;
    console.log(
      `[done] ${phase.phase}: migrated=${phase.migrated} skipped=${phase.skipped} errors=${errCount}`
    );
    if (errCount > 0) {
      for (const err of phase.errors.slice(0, 5)) {
        console.log(`       ${err.key}: ${err.message}`);
      }
      if (errCount > 5) console.log(`       ...and ${errCount - 5} more`);
    }
  }

  console.log(result.ok ? "Migration complete." : "Migration finished with errors.");
  process.exit(result.ok ? 0 : 1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.stats) {
    await runStats();
    return;
  }
  await run(args);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
