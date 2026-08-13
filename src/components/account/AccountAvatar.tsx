"use client";

export function AccountAvatar({
  name,
  imageUrl,
  size = 18,
}: {
  name: string;
  imageUrl?: string | null;
  size?: number;
}) {
  const initial = (name.trim().charAt(0) || "C").toUpperCase();
  if (imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-[var(--accent-bg)] font-sans font-medium text-[var(--text-primary)]"
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.45)) }}
      aria-hidden
    >
      {initial}
    </span>
  );
}
