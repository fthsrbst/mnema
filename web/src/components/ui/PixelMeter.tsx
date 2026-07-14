export function PixelMeter({
  value,
  max,
  blocks = 24,
  variant = "default",
}: {
  value: number;
  max: number;
  blocks?: number;
  variant?: "default" | "success" | "warning" | "danger";
}) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(ratio * blocks);
  return (
    <div className="pixel-meter" data-variant={variant} role="progressbar" aria-valuenow={value} aria-valuemax={max}>
      {Array.from({ length: blocks }).map((_, i) => (
        <span key={i} className="pixel-meter-block" data-filled={i < filled} />
      ))}
    </div>
  );
}
