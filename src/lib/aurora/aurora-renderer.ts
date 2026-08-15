/**
 * Canvas renderer for the aurora conversation backdrop: wavy curtain bands of
 * soft color drifting across the pane, whose pace, brightness, and tint react
 * to the conversation lifecycle — calm ambient drift when idle, a lifted glow
 * near the composer while typing, energetic flow with a traveling shimmer
 * while the agent works, a slow amber breath while waiting on the user, a
 * bright mint bloom on completion, and a brief crimson wash on failure.
 *
 * Draws at a very low internal resolution (the element upscales + blurs via
 * CSS), so a frame is ~a hundred tiny sprite blits — cheap even at 30fps.
 */

export type AuroraMood =
  | "new-chat"
  | "idle"
  | "typing"
  | "working"
  | "waiting"
  | "completed"
  | "error"
  | "paused";

export const AURORA_MOODS: AuroraMood[] = [
  "new-chat",
  "idle",
  "typing",
  "working",
  "waiting",
  "completed",
  "error",
  "paused",
];

export const AURORA_MOOD_LABELS: Record<AuroraMood, string> = {
  "new-chat": "New chat",
  idle: "Idle",
  typing: "Typing",
  working: "Working",
  waiting: "Needs input",
  completed: "Completed",
  error: "Error",
  paused: "Paused",
};

type Rgb = [number, number, number];

type MoodParams = {
  /** Horizontal drift / wave-phase speed multiplier. */
  flow: number;
  /** Wave amplitude multiplier. */
  energy: number;
  /** Overall alpha multiplier. */
  luminance: number;
  /** Strength of the up-welling glow behind the composer. */
  bottomGlow: number;
  /** 0..1 slow breathing of overall alpha. */
  pulse: number;
  /** 0..1 strength of the highlight traveling along the bands. */
  shimmer: number;
  /** Color washed into the bands (completion mint, error crimson, waiting amber). */
  tint: Rgb | null;
  tintStrength: number;
};

const MOOD_TARGETS: Record<AuroraMood, MoodParams> = {
  "new-chat": {
    flow: 0.55,
    energy: 0.95,
    luminance: 0.95,
    bottomGlow: 0.3,
    pulse: 0,
    shimmer: 0.25,
    tint: null,
    tintStrength: 0,
  },
  idle: {
    flow: 0.32,
    energy: 0.7,
    luminance: 0.6,
    bottomGlow: 0.12,
    pulse: 0,
    shimmer: 0.12,
    tint: null,
    tintStrength: 0,
  },
  typing: {
    flow: 0.5,
    energy: 0.8,
    luminance: 0.8,
    bottomGlow: 0.62,
    pulse: 0,
    shimmer: 0.2,
    tint: null,
    tintStrength: 0,
  },
  working: {
    flow: 1.7,
    energy: 1.25,
    luminance: 1.05,
    bottomGlow: 0.35,
    pulse: 0.12,
    shimmer: 1,
    tint: null,
    tintStrength: 0,
  },
  waiting: {
    flow: 0.45,
    energy: 0.75,
    luminance: 0.92,
    bottomGlow: 0.55,
    pulse: 0.85,
    shimmer: 0.2,
    tint: [251, 191, 36],
    tintStrength: 0.24,
  },
  completed: {
    flow: 0.75,
    energy: 0.95,
    luminance: 1.5,
    bottomGlow: 0.55,
    pulse: 0,
    shimmer: 0.5,
    tint: [167, 243, 208],
    tintStrength: 0.38,
  },
  error: {
    flow: 0.35,
    energy: 0.65,
    luminance: 0.92,
    bottomGlow: 0.42,
    pulse: 0.3,
    shimmer: 0.1,
    tint: [244, 63, 94],
    tintStrength: 0.52,
  },
  paused: {
    flow: 0.12,
    energy: 0.45,
    luminance: 0.34,
    bottomGlow: 0.08,
    pulse: 0,
    shimmer: 0,
    tint: null,
    tintStrength: 0,
  },
};

export type AuroraRendererOptions = {
  /** 0..100 from settings. */
  intensity: number;
  /** 0..100 from settings; 50 is the designed pace. */
  speed: number;
  /** Dark appearance draws brighter (screen-blended); light stays pastel. */
  isDark: boolean;
};

function parseHexColor(hex: string): Rgb {
  const value = hex.replace("#", "");
  const num = Number.parseInt(value, 16);
  if (!Number.isFinite(num) || value.length !== 6) {
    return [56, 189, 248];
  }
  return [(num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff];
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/** Soft radial sprite, cached per quantized color. Stamped stretched for curtains and glows. */
function makeSprite(rgb: Rgb): HTMLCanvasElement {
  const size = 128;
  const sprite = document.createElement("canvas");
  sprite.width = size;
  sprite.height = size;
  const ctx = sprite.getContext("2d");
  if (!ctx) {
    return sprite;
  }
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  const [r, g, b] = rgb.map(Math.round);
  gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`);
  gradient.addColorStop(0.42, `rgba(${r}, ${g}, ${b}, 0.5)`);
  gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return sprite;
}

type BandSpec = {
  color: Rgb;
  /** Ridge height as a fraction of canvas height. */
  baseY: number;
  /** Wave phase offsets so bands never sync up. */
  phase: number;
  /** Alternating drift direction. */
  direction: 1 | -1;
  alpha: number;
};

function buildBands(colors: string[]): BandSpec[] {
  const parsed = colors.slice(0, 5).map(parseHexColor);
  while (parsed.length < 2) {
    parsed.push([139, 92, 246]);
  }
  const count = parsed.length;
  return parsed.map((color, index) => ({
    color,
    baseY: 0.16 + (0.42 / Math.max(1, count - 1)) * index,
    phase: index * 2.39996, // golden angle keeps the waves visually unrelated
    direction: index % 2 === 0 ? 1 : -1,
    alpha: 0.5 - index * 0.05,
  }));
}

const SMOOTH_ATTACK_TAU_MS = 450;
const SMOOTH_RELEASE_TAU_MS = 1500;

function approach(current: number, target: number, dtMs: number): number {
  const tau = Math.abs(target) > Math.abs(current) ? SMOOTH_ATTACK_TAU_MS : SMOOTH_RELEASE_TAU_MS;
  const k = 1 - Math.exp(-dtMs / tau);
  return current + (target - current) * k;
}

export type AuroraRenderer = {
  setMood(mood: AuroraMood): void;
  setPalette(colors: string[]): void;
  setOptions(options: AuroraRendererOptions): void;
  /** Advance the simulation and paint one frame. `dtMs` since the previous call. */
  render(ctx: CanvasRenderingContext2D, width: number, height: number, dtMs: number): void;
  /** Jump smoothing to the current mood targets (first paint, reduced motion). */
  snapToMood(): void;
};

export function createAuroraRenderer(): AuroraRenderer {
  let mood: AuroraMood = "idle";
  let bands: BandSpec[] = buildBands(["#22e0a6", "#38bdf8", "#8b5cf6", "#d946ef"]);
  let options: AuroraRendererOptions = { intensity: 55, speed: 50, isDark: true };

  const params: MoodParams = { ...MOOD_TARGETS.idle, tint: null };
  let tintColor: Rgb = [255, 255, 255];

  /** Accumulated wave phase; scaling by flow/speed at accumulation time keeps changes seamless. */
  let flowTime = 12_000;
  let clockMs = 0;

  const spriteCache = new Map<string, HTMLCanvasElement>();
  const spriteFor = (rgb: Rgb): HTMLCanvasElement => {
    // Quantize so tint interpolation doesn't mint a sprite per frame.
    const key = rgb.map((v) => Math.round(v / 8) * 8).join(",");
    let sprite = spriteCache.get(key);
    if (!sprite) {
      if (spriteCache.size > 96) {
        spriteCache.clear();
      }
      sprite = makeSprite(rgb);
      spriteCache.set(key, sprite);
    }
    return sprite;
  };

  const speedMultiplier = (): number => {
    const normalized = options.speed / 50;
    return 0.1 + Math.pow(normalized, 1.35) * 0.9;
  };

  const step = (dtMs: number): void => {
    const target = MOOD_TARGETS[mood];
    params.flow = approach(params.flow, target.flow, dtMs);
    params.energy = approach(params.energy, target.energy, dtMs);
    params.luminance = approach(params.luminance, target.luminance, dtMs);
    params.bottomGlow = approach(params.bottomGlow, target.bottomGlow, dtMs);
    params.pulse = approach(params.pulse, target.pulse, dtMs);
    params.shimmer = approach(params.shimmer, target.shimmer, dtMs);
    params.tintStrength = approach(params.tintStrength, target.tintStrength, dtMs);
    if (target.tint) {
      tintColor = mixRgb(tintColor, target.tint, 1 - Math.exp(-dtMs / SMOOTH_ATTACK_TAU_MS));
    }
    const pace = speedMultiplier();
    flowTime += dtMs * params.flow * pace;
    clockMs += dtMs * pace;
  };

  const draw = (ctx: CanvasRenderingContext2D, w: number, h: number): void => {
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";

    const intensityFactor = Math.pow(options.intensity / 100, 1.15) * (options.isDark ? 1 : 0.8);
    const breath = 1 + params.pulse * 0.3 * Math.sin(clockMs * 0.0016);
    const master = intensityFactor * params.luminance * breath;
    if (master <= 0.001) {
      return;
    }

    const t = flowTime;
    const stepX = Math.max(8, w / 22);
    const margin = stepX * 2;

    for (const [index, band] of bands.entries()) {
      const color = params.tintStrength > 0.01
        ? mixRgb(band.color, tintColor, Math.min(1, params.tintStrength) * 0.65)
        : band.color;
      const sprite = spriteFor(color);
      const dir = band.direction;
      const baseY = band.baseY * h;
      const amp1 = h * 0.075 * params.energy;
      const amp2 = h * 0.04 * params.energy;
      const k1 = (Math.PI * 2) / (w * (1.15 - index * 0.12));
      const k2 = (Math.PI * 2) / (w * 0.52);
      const drift = dir * t * 0.00023;
      // Traveling highlight: a gaussian window sweeping along the band.
      const shimmerCenter = ((t * 0.000045 + index * 0.37) % 1.4) - 0.2;

      for (let x = -margin; x <= w + margin; x += stepX) {
        const fx = x / w;
        const y =
          baseY +
          Math.sin(x * k1 + drift + band.phase) * amp1 +
          Math.sin(x * k2 - drift * 1.7 + band.phase * 1.3) * amp2;
        const envelope =
          0.62 + 0.38 * Math.sin(fx * 4.1 + t * 0.00019 * dir + band.phase * 2.1);
        const shimmerBoost =
          params.shimmer > 0.01
            ? Math.exp(-((fx - shimmerCenter) ** 2) / 0.012) * params.shimmer * 0.85
            : 0;
        const alpha = band.alpha * envelope * (1 + shimmerBoost) * master;
        if (alpha <= 0.004) {
          continue;
        }
        const sway = Math.sin(x * k2 * 0.7 + t * 0.00013 + band.phase) * 0.35;
        const sw = stepX * 3.1;
        const sh = sw * (1.85 + sway) * (0.9 + params.energy * 0.25);
        ctx.globalAlpha = Math.min(0.85, alpha);
        // Curtains hang downward from the ridge.
        ctx.drawImage(sprite, x - sw / 2, y - sh * 0.22, sw, sh);
      }
    }

    // Up-welling glow behind the composer; brightens while typing/waiting.
    if (params.bottomGlow > 0.015) {
      const glowColor = params.tintStrength > 0.01
        ? mixRgb(bands[0].color, tintColor, Math.min(1, params.tintStrength) * 0.65)
        : mixRgb(bands[0].color, bands[bands.length - 1].color, 0.35);
      const sprite = spriteFor(glowColor);
      const wander = Math.sin(t * 0.00011) * w * 0.08;
      const gw = w * 1.5;
      const gh = h * 0.62;
      ctx.globalAlpha = Math.min(0.6, params.bottomGlow * master * 0.55);
      ctx.drawImage(sprite, w / 2 - gw / 2 + wander, h - gh * 0.42, gw, gh);
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  };

  return {
    setMood(next) {
      mood = next;
    },
    setPalette(colors) {
      bands = buildBands(colors);
    },
    setOptions(next) {
      options = next;
    },
    snapToMood() {
      const target = MOOD_TARGETS[mood];
      params.flow = target.flow;
      params.energy = target.energy;
      params.luminance = target.luminance;
      params.bottomGlow = target.bottomGlow;
      params.pulse = target.pulse;
      params.shimmer = target.shimmer;
      params.tintStrength = target.tintStrength;
      if (target.tint) {
        tintColor = target.tint;
      }
    },
    render(ctx, width, height, dtMs) {
      step(Math.min(120, Math.max(0, dtMs)));
      draw(ctx, width, height);
    },
  };
}
