"use client";

/**
 * MAX / model UI: `variant="blue"` (default). Agent-style settings in Cursor
 * use green when on — pass `variant="green"` for those rows.
 */
export function ToggleSwitch({
  checked,
  onChange,
  size = "sm",
  variant = "blue",
  labelledBy,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  size?: "sm" | "md";
  variant?: "blue" | "green";
  labelledBy?: string;
  disabled?: boolean;
}) {
  const sm = { h: 18, w: 32, knob: 14, offX: 2, onX: 16 };
  const md = { h: 22, w: 40, knob: 16, offX: 2, onX: 22 };
  const d = size === "md" ? md : sm;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative inline-flex shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        height: d.h,
        width: d.w,
        background: checked
          ? variant === "green"
            ? "var(--status-success)"
            : "var(--accent)"
          : "var(--border-card)",
      }}
    >
      <span
        className="block rounded-full shadow"
        style={{
          // Contrast against the track in every theme: `--accent` can be
          // white (default dark), so a fixed white knob would disappear.
          background: checked ? "var(--bg-main)" : "var(--text-primary)",
          width: d.knob,
          height: d.knob,
          transform: checked
            ? `translateX(${d.onX}px)`
            : `translateX(${d.offX}px)`,
          transition: "transform 150ms ease-out",
        }}
      />
    </button>
  );
}
