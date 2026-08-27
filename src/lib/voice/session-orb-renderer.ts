/**
 * Canvas renderer for the voice-agent session orb: a luminous core with a
 * slow-orbiting aurora ribbon, level-reactive halo rings, orbiting sparks,
 * and speech ripples that radiate outward on audio energy.
 *
 * Rendering is driven by a stateful `SessionOrbAnimator` so everything the
 * eye tracks is continuous:
 *
 *   - status themes CROSSFADE (colors, motion speed, glow) instead of
 *     snapping when the session state changes;
 *   - motion runs on accumulated phase, so a churn-speed change accelerates
 *     the ribbon smoothly rather than teleporting it;
 *   - audio level uses fast-attack / slow-release smoothing and spawns
 *     expanding ripples on speech onsets (mic while listening, TTS output
 *     while speaking).
 *
 * Status color identities:
 *
 *   idle         dim neutral drift
 *   listening    cool cyan breathing
 *   capturing    bright teal swell synced to mic level
 *   transcribing violet fast churn
 *   sending      violet fast churn (agent is being prompted)
 *   working      deep indigo steady churn (agent turn running in the thread)
 *   speaking     warm amber pulse synced to TTS output level
 *   error        muted red slow pulse (mic/pipeline failure - see caption)
 */

export type SessionOrbStatus =
  | "idle"
  | "listening"
  | "capturing"
  | "transcribing"
  | "sending"
  | "working"
  | "speaking"
  | "error";

type Rgb = [number, number, number];

type StatusTheme = {
  core: Rgb;
  ribbon: Rgb;
  halo: Rgb;
  /** Motion speed multiplier for the ribbon/rings/sparks. */
  churn: number;
  /** Constant radius bias added on top of breathing. */
  swell: number;
  /** Ambient glow strength behind the core. */
  glow: number;
};

const THEMES: Record<SessionOrbStatus, StatusTheme> = {
  idle: {
    core: [148, 155, 170],
    ribbon: [96, 104, 122],
    halo: [120, 128, 146],
    churn: 0.55,
    swell: 0.008,
    glow: 0.28,
  },
  listening: {
    core: [116, 196, 236],
    ribbon: [66, 132, 210],
    halo: [96, 174, 228],
    churn: 1,
    swell: 0.02,
    glow: 0.5,
  },
  capturing: {
    core: [92, 226, 202],
    ribbon: [46, 168, 176],
    halo: [80, 214, 196],
    churn: 1.7,
    swell: 0.05,
    glow: 0.72,
  },
  transcribing: {
    core: [178, 148, 250],
    ribbon: [124, 92, 226],
    halo: [156, 128, 240],
    churn: 3.2,
    swell: 0.02,
    glow: 0.62,
  },
  sending: {
    core: [178, 148, 250],
    ribbon: [124, 92, 226],
    halo: [156, 128, 240],
    churn: 3.9,
    swell: 0.02,
    glow: 0.66,
  },
  working: {
    core: [138, 152, 244],
    ribbon: [92, 106, 214],
    halo: [120, 136, 236],
    churn: 2.2,
    swell: 0.016,
    glow: 0.58,
  },
  speaking: {
    core: [250, 196, 122],
    ribbon: [226, 142, 66],
    halo: [244, 178, 104],
    churn: 1.5,
    swell: 0.03,
    glow: 0.74,
  },
  error: {
    core: [214, 118, 122],
    ribbon: [168, 66, 74],
    halo: [204, 96, 104],
    churn: 0.4,
    swell: 0.012,
    glow: 0.4,
  },
};

/** Numeric channels blended between themes each frame. */
type ThemeVector = {
  core: Rgb;
  ribbon: Rgb;
  halo: Rgb;
  churn: number;
  swell: number;
  glow: number;
};

type Ripple = {
  /** 0..1 progress, advanced by dt. */
  progress: number;
  strength: number;
};

const RIPPLE_LIFETIME_MS = 950;
const RIPPLE_SPAWN_COOLDOWN_MS = 190;
/** Time constant (ms) for the theme crossfade. */
const THEME_BLEND_TAU_MS = 200;

function rgba(color: Rgb, alpha: number): string {
  return `rgba(${Math.round(color[0])}, ${Math.round(color[1])}, ${Math.round(color[2])}, ${alpha})`;
}

function lerp(from: number, to: number, k: number): number {
  return from + (to - from) * k;
}

function lerpRgb(from: Rgb, to: Rgb, k: number): Rgb {
  return [
    lerp(from[0], to[0], k),
    lerp(from[1], to[1], k),
    lerp(from[2], to[2], k),
  ];
}

function cloneTheme(theme: StatusTheme): ThemeVector {
  return {
    core: [...theme.core],
    ribbon: [...theme.ribbon],
    halo: [...theme.halo],
    churn: theme.churn,
    swell: theme.swell,
    glow: theme.glow,
  };
}

export type SessionOrbFrameInput = {
  status: SessionOrbStatus;
  /** 0..1 microphone level. */
  micLevel: number;
  /** 0..1 TTS output level. */
  ttsLevel: number;
  timeMs: number;
  /** Skips ripples/sparks and slows everything down. */
  reducedMotion?: boolean;
};

/**
 * Stateful animator: one instance per mounted orb canvas. Feed it frames via
 * `draw`; it owns level smoothing, theme blending, phase accumulation, and
 * ripple lifecycle so callers stay dumb.
 */
export class SessionOrbAnimator {
  private initialized = false;
  private blended: ThemeVector = cloneTheme(THEMES.idle);
  private smoothedLevel = 0;
  /** Slow envelope of the level, used for onset (rising-edge) detection. */
  private levelEnvelope = 0;
  /** Accumulated churn-scaled phase (ms-equivalent at churn 1). */
  private phaseMs = 0;
  private lastTimeMs: number | null = null;
  private lastRippleAtMs = 0;
  private ripples: Ripple[] = [];

  draw(
    ctx: CanvasRenderingContext2D,
    cssSize: number,
    input: SessionOrbFrameInput
  ): void {
    const dpr =
      typeof window !== "undefined"
        ? Math.min(window.devicePixelRatio || 1, 2)
        : 1;
    const size = cssSize * dpr;
    const target = THEMES[input.status] ?? THEMES.idle;
    if (!this.initialized) {
      // First frame adopts the live status outright so a freshly mounted orb
      // (e.g. the dock right after minimizing) matches the orb it replaces
      // instead of crossfading up from idle gray.
      this.initialized = true;
      this.blended = cloneTheme(target);
    }
    const t = input.timeMs;
    const dt =
      this.lastTimeMs === null ? 16 : Math.min(120, Math.max(0, t - this.lastTimeMs));
    this.lastTimeMs = t;

    // ---- Level smoothing: fast attack, slow release ----------------------
    const rawLevel = Math.min(
      1,
      Math.max(
        0,
        Math.max(input.micLevel, input.status === "speaking" ? input.ttsLevel : 0)
      )
    );
    const attack = 1 - Math.exp(-dt / 40);
    const release = 1 - Math.exp(-dt / 220);
    this.smoothedLevel +=
      (rawLevel - this.smoothedLevel) *
      (rawLevel > this.smoothedLevel ? attack : release);
    const level = this.smoothedLevel;

    // ---- Theme crossfade ---------------------------------------------------
    const blend = 1 - Math.exp(-dt / THEME_BLEND_TAU_MS);
    this.blended = {
      core: lerpRgb(this.blended.core, target.core, blend),
      ribbon: lerpRgb(this.blended.ribbon, target.ribbon, blend),
      halo: lerpRgb(this.blended.halo, target.halo, blend),
      churn: lerp(this.blended.churn, target.churn, blend),
      swell: lerp(this.blended.swell, target.swell, blend),
      glow: lerp(this.blended.glow, target.glow, blend),
    };
    const theme = this.blended;

    // ---- Phase accumulation: churn changes accelerate, never teleport ----
    const motionScale = input.reducedMotion ? 0.35 : 1;
    this.phaseMs += dt * theme.churn * (1 + level * 0.5) * motionScale;
    const phase = this.phaseMs;

    // ---- Ripple lifecycle: spawn on speech onsets, advance, cull ---------
    if (!input.reducedMotion) {
      const envBlend = 1 - Math.exp(-dt / 320);
      const rising = rawLevel - this.levelEnvelope;
      this.levelEnvelope += (rawLevel - this.levelEnvelope) * envBlend;
      const audible =
        input.status === "capturing" ||
        input.status === "speaking" ||
        input.status === "listening";
      if (
        audible &&
        rising > 0.09 &&
        rawLevel > 0.16 &&
        t - this.lastRippleAtMs > RIPPLE_SPAWN_COOLDOWN_MS
      ) {
        this.lastRippleAtMs = t;
        this.ripples.push({ progress: 0, strength: Math.min(1, rawLevel * 1.4) });
        if (this.ripples.length > 5) this.ripples.shift();
      }
      for (const ripple of this.ripples) {
        ripple.progress += dt / RIPPLE_LIFETIME_MS;
      }
      this.ripples = this.ripples.filter((ripple) => ripple.progress < 1);
    } else if (this.ripples.length > 0) {
      this.ripples = [];
    }

    // ---- Paint ------------------------------------------------------------
    const center = size / 2;
    ctx.save();
    ctx.clearRect(0, 0, size, size);

    const breathe =
      Math.sin(t * 0.0012) * 0.01 + Math.sin(t * 0.0027 + 1.1) * 0.006;
    const coreRadius =
      center * 0.56 * (1 + breathe + theme.swell + level * 0.16);

    // Speech ripples: expanding rings radiating from the core edge.
    for (const ripple of this.ripples) {
      const eased = 1 - (1 - ripple.progress) * (1 - ripple.progress);
      const radius = coreRadius * (1.06 + eased * 0.72);
      if (radius >= center) continue;
      const alpha = (1 - ripple.progress) * 0.34 * ripple.strength;
      ctx.beginPath();
      ctx.arc(center, center, radius, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1, size * 0.008 * (1 - ripple.progress * 0.6));
      ctx.strokeStyle = rgba(theme.halo, Math.max(0, alpha));
      ctx.stroke();
    }

    // Level-reactive halo rings around the core.
    for (let ring = 0; ring < 3; ring++) {
      const ringPhase = phase * 0.0016 + ring * 2.1;
      const ringLevel = level * (1 - ring * 0.28);
      const ringRadius =
        coreRadius *
        (1.24 + ring * 0.24 + Math.sin(ringPhase) * 0.035 + ringLevel * 0.26);
      if (ringRadius >= center) continue;
      const ringAlpha =
        (0.16 - ring * 0.045 + ringLevel * 0.22) *
        (input.status === "idle" ? 0.5 : 1);
      ctx.beginPath();
      ctx.arc(center, center, ringRadius, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1, size * (0.006 - ring * 0.0012));
      ctx.strokeStyle = rgba(theme.halo, Math.max(0, ringAlpha));
      ctx.stroke();
    }

    // Orbiting sparks riding the outer halo (skipped when idle/reduced).
    if (!input.reducedMotion && input.status !== "idle") {
      for (let spark = 0; spark < 5; spark++) {
        const sparkAngle =
          phase * 0.00052 * (spark % 2 === 0 ? 1 : -0.8) +
          (spark * Math.PI * 2) / 5;
        const wobble = Math.sin(phase * 0.0011 + spark * 2.2) * 0.05;
        const orbit = coreRadius * (1.3 + (spark % 3) * 0.14 + wobble + level * 0.18);
        if (orbit >= center) continue;
        const sx = center + Math.cos(sparkAngle) * orbit;
        const sy = center + Math.sin(sparkAngle) * orbit;
        const sparkRadius = Math.max(1, size * (0.0075 + level * 0.004));
        const twinkle = 0.35 + 0.3 * Math.sin(phase * 0.004 + spark * 1.9);
        ctx.beginPath();
        ctx.arc(sx, sy, sparkRadius, 0, Math.PI * 2);
        ctx.fillStyle = rgba(theme.halo, Math.max(0, twinkle * (0.5 + level * 0.5)));
        ctx.fill();
      }
    }

    // Ambient glow behind the core.
    const glow = ctx.createRadialGradient(
      center,
      center,
      coreRadius * 0.2,
      center,
      center,
      Math.min(center, coreRadius * 2.1)
    );
    glow.addColorStop(0, rgba(theme.core, theme.glow * (0.5 + level * 0.5)));
    glow.addColorStop(1, rgba(theme.core, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);

    // Core sphere.
    ctx.beginPath();
    ctx.arc(center, center, coreRadius, 0, Math.PI * 2);
    ctx.clip();

    const base = ctx.createRadialGradient(
      center - coreRadius * 0.28,
      center - coreRadius * 0.32,
      coreRadius * 0.08,
      center,
      center,
      coreRadius * 1.12
    );
    base.addColorStop(0, "rgba(252, 253, 255, 0.98)");
    base.addColorStop(0.42, rgba(theme.core, 0.92));
    base.addColorStop(1, rgba(theme.ribbon, 0.96));
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);

    // Aurora ribbon: three orbiting energy blobs inside the core.
    for (let blob = 0; blob < 3; blob++) {
      const angle = phase * 0.00042 * (blob % 2 === 0 ? 1 : -1.35) + blob * 2.4;
      const wobble = Math.sin(phase * 0.0011 + blob * 1.7);
      const bx = center + Math.cos(angle) * coreRadius * (0.34 + wobble * 0.08);
      const by =
        center + Math.sin(angle * 1.22) * coreRadius * (0.3 + wobble * 0.06);
      const blobRadius = coreRadius * (0.5 + blob * 0.12 + level * 0.12);
      const blobGradient = ctx.createRadialGradient(bx, by, 0, bx, by, blobRadius);
      blobGradient.addColorStop(0, rgba(theme.ribbon, 0.5 + level * 0.28));
      blobGradient.addColorStop(0.65, rgba(theme.ribbon, 0.18));
      blobGradient.addColorStop(1, rgba(theme.ribbon, 0));
      ctx.fillStyle = blobGradient;
      ctx.fillRect(0, 0, size, size);
    }

    // Specular highlight and rim shading for depth.
    const highlight = ctx.createRadialGradient(
      center - coreRadius * 0.36,
      center - coreRadius * 0.42,
      0,
      center - coreRadius * 0.36,
      center - coreRadius * 0.42,
      coreRadius * 0.8
    );
    highlight.addColorStop(0, "rgba(255, 255, 255, 0.55)");
    highlight.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = highlight;
    ctx.fillRect(0, 0, size, size);

    const rim = ctx.createRadialGradient(
      center,
      center,
      coreRadius * 0.7,
      center,
      center,
      coreRadius
    );
    rim.addColorStop(0, "rgba(0, 0, 0, 0)");
    rim.addColorStop(1, "rgba(12, 16, 26, 0.32)");
    ctx.fillStyle = rim;
    ctx.fillRect(0, 0, size, size);

    ctx.restore();
  }
}
