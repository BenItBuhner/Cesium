/**
 * Opt-in full Linux VM tier (experimental): boots v86 (Apache-2.0
 * x86-to-wasm emulator) with a user-supplied bootable image and bridges its
 * serial console into the browser machine shell. This is the universal
 * fallback for toolchains that have no wasm build (native compilers, Godot
 * exports, etc.) - slow, but it runs real distro userlands entirely
 * client-side.
 *
 * Usage from the terminal:
 *   vm start --image <url-to-v86-compatible-image.iso|.bin> [--memory 256]
 *   vm exec <command>        # send a line to the serial console
 *   vm status | vm stop
 */
import type { ShellRuntime } from "../shell/runtime";
import type { ShellContext } from "../shell/builtins";
import { readDoc, writeDoc } from "../stores/kv-docs";

const V86_MODULE_URL = "https://cdn.jsdelivr.net/npm/v86@0.5.308/build/libv86.mjs";
const VM_IMAGE_KEY = "vm:image-url";

type V86Emulator = {
  add_listener(event: string, handler: (data: unknown) => void): void;
  serial0_send(text: string): void;
  stop(): Promise<void> | void;
};

type VmState = {
  emulator: V86Emulator;
  serialBuffer: string;
  ready: boolean;
};

let vmState: VmState | null = null;

async function startVm(input: {
  imageUrl: string;
  memoryMb: number;
  onSerial: (text: string) => void;
}): Promise<VmState> {
  const v86Module = (await import(/* webpackIgnore: true */ V86_MODULE_URL)) as {
    V86: new (options: Record<string, unknown>) => V86Emulator;
  };
  const isIso = /\.iso(\?|$)/i.test(input.imageUrl);
  const emulator = new v86Module.V86({
    wasm_path: V86_MODULE_URL.replace("libv86.mjs", "v86.wasm"),
    memory_size: input.memoryMb * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    ...(isIso
      ? { cdrom: { url: input.imageUrl } }
      : { bzimage_initrd_from_filesystem: false, hda: { url: input.imageUrl, async: true } }),
    autostart: true,
    disable_keyboard: true,
    disable_mouse: true,
    network_relay_url: undefined,
  });
  const state: VmState = { emulator, serialBuffer: "", ready: false };
  emulator.add_listener("serial0-output-byte", (byte) => {
    const char = String.fromCharCode(byte as number);
    state.serialBuffer = (state.serialBuffer + char).slice(-50_000);
    state.ready = true;
    input.onSerial(char);
  });
  return state;
}

export function registerVmCommand(shell: ShellRuntime): void {
  shell.registerCommand("vm", async (argv: string[], ctx: ShellContext): Promise<number> => {
    const sub = argv[0] ?? "status";
    if (sub === "start") {
      if (vmState) {
        ctx.io.write("vm: already running (use `vm exec <cmd>` or `vm stop`)\n");
        return 0;
      }
      let imageUrl = (await readDoc<string>(VM_IMAGE_KEY)) ?? "";
      let memoryMb = 256;
      for (let i = 1; i < argv.length; i += 1) {
        const arg = argv[i] as string;
        if (arg === "--image") imageUrl = argv[++i] ?? imageUrl;
        else if (arg === "--memory") memoryMb = Number.parseInt(argv[++i] ?? "256", 10) || 256;
      }
      if (!imageUrl) {
        ctx.io.writeErr(
          "vm start: no image configured. Pass --image <url> pointing at a v86-compatible Linux image (e.g. a 32-bit Alpine ISO hosted with CORS enabled). The URL is remembered for next time.\n"
        );
        return 1;
      }
      await writeDoc(VM_IMAGE_KEY, imageUrl);
      ctx.io.write(
        `vm: booting ${imageUrl} with ${memoryMb} MB RAM. This is full CPU emulation - expect minutes, not seconds. Serial console output follows:\n`
      );
      try {
        vmState = await startVm({
          imageUrl,
          memoryMb,
          onSerial: (text) => ctx.io.write(text),
        });
        // Give the boot 20 seconds of streaming before returning the prompt.
        await new Promise((resolve) => setTimeout(resolve, 20_000));
        ctx.io.write(
          "\nvm: boot continues in the background; run `vm exec <command>` to interact, `vm tail` to see recent console output.\n"
        );
        return 0;
      } catch (error) {
        vmState = null;
        ctx.io.writeErr(
          `vm start failed: ${error instanceof Error ? error.message : String(error)} (the image host must allow CORS)\n`
        );
        return 1;
      }
    }
    if (sub === "exec") {
      if (!vmState) {
        ctx.io.writeErr("vm exec: no VM running (use `vm start`)\n");
        return 1;
      }
      const command = argv.slice(1).join(" ");
      if (!command) {
        ctx.io.writeErr("vm exec: missing command\n");
        return 1;
      }
      const before = vmState.serialBuffer.length;
      vmState.emulator.serial0_send(`${command}\n`);
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      ctx.io.write(vmState.serialBuffer.slice(before));
      return 0;
    }
    if (sub === "tail") {
      if (!vmState) {
        ctx.io.writeErr("vm tail: no VM running\n");
        return 1;
      }
      ctx.io.write(vmState.serialBuffer.slice(-4_000));
      return 0;
    }
    if (sub === "stop") {
      if (vmState) {
        await vmState.emulator.stop();
        vmState = null;
      }
      ctx.io.write("vm: stopped\n");
      return 0;
    }
    ctx.io.write(
      vmState
        ? "vm: running (serial console attached). Subcommands: exec, tail, stop\n"
        : "vm: not running. Subcommands: start --image <url> [--memory MB], exec, tail, stop\n"
    );
    return 0;
  });
}
