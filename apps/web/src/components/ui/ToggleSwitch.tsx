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
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  size?: "sm" | "md";
  variant?: "blue" | "green";
  labelledBy?: string;
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
      onClick={() => onChange(!checked)}
      className="relative inline-flex shrink-0 cursor-pointer items-center rounded-full transition-colors"
      style={{
        height: d.h,
        width: d.w,
        background: checked
          ? variant === "green"
            ? "#22c55e"
            : "#2563eb"
          : "var(--border-card)",
      }}
    >
      <span
        className="block rounded-full bg-white shadow"
        style={{
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
