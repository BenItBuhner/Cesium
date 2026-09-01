/**
 * Toolchain packs: optional language runtimes loaded on demand from CDNs
 * and registered as shell commands. The pack list feeds the agent's
 * environment reminder so the model always knows what is actually runnable.
 */
import type { Vfs } from "../vfs";
import type { ShellRuntime } from "../shell/runtime";
import type { ShellContext } from "../shell/builtins";
import { readDoc, writeDoc } from "../stores/kv-docs";

const INSTALLED_PACKS_KEY = "packs:installed";

export type ToolchainPack = {
  id: string;
  label: string;
  description: string;
  approxSize: string;
  commands: string[];
  status: "available" | "experimental" | "planned";
  load?: (shell: ShellRuntime, vfs: Vfs) => Promise<void>;
};

export class PackManager {
  private readonly packs = new Map<string, ToolchainPack>();
  private readonly loaded = new Set<string>();

  constructor(
    private readonly shell: ShellRuntime,
    private readonly vfs: Vfs
  ) {}

  register(pack: ToolchainPack): void {
    this.packs.set(pack.id, pack);
  }

  list(): Array<ToolchainPack & { installed: boolean }> {
    return [...this.packs.values()].map((pack) => ({
      ...pack,
      installed: this.loaded.has(pack.id),
    }));
  }

  installedSummaries(): string[] {
    return [...this.loaded].map((id) => {
      const pack = this.packs.get(id);
      return pack ? `${pack.label} (${pack.commands.join(", ")})` : id;
    });
  }

  async install(packId: string, onProgress?: (message: string) => void): Promise<void> {
    const pack = this.packs.get(packId);
    if (!pack) {
      throw new Error(`Unknown pack: ${packId}`);
    }
    if (this.loaded.has(packId)) return;
    if (pack.status === "planned" || !pack.load) {
      throw new Error(
        `${pack.label} is on the roadmap but not yet loadable in the browser. Use a server/Codespace machine for this toolchain.`
      );
    }
    onProgress?.(`Loading ${pack.label} (~${pack.approxSize})…`);
    await pack.load(this.shell, this.vfs);
    this.loaded.add(packId);
    const stored = (await readDoc<string[]>(INSTALLED_PACKS_KEY)) ?? [];
    if (!stored.includes(packId)) {
      await writeDoc(INSTALLED_PACKS_KEY, [...stored, packId]);
    }
    onProgress?.(`${pack.label} ready.`);
  }

  /** Re-load packs the user installed in previous sessions. */
  async restoreInstalled(): Promise<void> {
    const stored = (await readDoc<string[]>(INSTALLED_PACKS_KEY)) ?? [];
    for (const packId of stored) {
      await this.install(packId).catch((error) => {
        console.warn(`[browser-machine] pack restore failed (${packId}):`, error);
      });
    }
  }

  registerShellCommand(): void {
    this.shell.registerCommand("packs", async (argv: string[], ctx: ShellContext) => {
      const sub = argv[0] ?? "list";
      if (sub === "list") {
        for (const pack of this.list()) {
          const state = pack.installed
            ? "installed"
            : pack.status === "planned"
              ? "planned (not yet loadable)"
              : `available (~${pack.approxSize})`;
          ctx.io.write(`${pack.id.padEnd(12)} ${state.padEnd(28)} ${pack.description}\n`);
        }
        return 0;
      }
      if (sub === "install") {
        const packId = argv[1];
        if (!packId) {
          ctx.io.writeErr("packs install: missing pack id\n");
          return 1;
        }
        try {
          await this.install(packId, (message) => ctx.io.write(`${message}\n`));
          return 0;
        } catch (error) {
          ctx.io.writeErr(
            `packs install: ${error instanceof Error ? error.message : String(error)}\n`
          );
          return 1;
        }
      }
      ctx.io.writeErr("packs: usage: packs [list|install <id>]\n");
      return 1;
    });
  }
}
