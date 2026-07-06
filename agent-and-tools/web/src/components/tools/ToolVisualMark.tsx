import { IconTile } from "@/components/ui/primitives";
import type { ToolVisual } from "@/lib/toolVisuals";
import { toolVisualPillClass } from "@/lib/toolVisuals";

function brandTint(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(clean)) return `rgba(15, 23, 42, ${alpha})`;
  const value = Number.parseInt(clean, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function BrandSvg({ visual, size }: { visual: ToolVisual; size: "sm" | "md" | "lg" }) {
  const icon = visual.product?.simpleIcon;
  if (!icon) return null;

  const iconSize = size === "lg" ? 30 : size === "md" ? 24 : 18;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={iconSize}
      height={iconSize}
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d={icon.path} />
    </svg>
  );
}

export function ToolVisualMark({
  visual,
  size = "md",
}: {
  visual: ToolVisual;
  size?: "sm" | "md" | "lg";
}) {
  if (!visual.product) {
    return <IconTile icon={visual.icon} tone={visual.tone} size={size} title={visual.label} />;
  }

  const sizes = {
    sm: "h-9 w-9 rounded-lg text-[11px]",
    md: "h-12 w-12 rounded-lg text-[11px]",
    lg: "h-14 w-14 rounded-lg text-xs",
  } as const;
  const brandIcon = visual.product.simpleIcon;
  const CategoryIcon = visual.icon;
  const style = brandIcon
    ? {
        color: `#${brandIcon.hex}`,
        background: `linear-gradient(135deg, #ffffff 0%, ${brandTint(brandIcon.hex, 0.13)} 100%)`,
        borderColor: brandTint(brandIcon.hex, 0.2),
      }
    : undefined;

  return (
    <span
      title={visual.product.name}
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden border shadow-sm ring-1 ${sizes[size]} ${brandIcon ? "ring-transparent" : visual.product.tileClass}`}
      style={style}
    >
      {brandIcon ? <BrandSvg visual={visual} size={size} /> : <span className="font-black">{visual.product.mark}</span>}
      {brandIcon && size !== "sm" && (
        <span className="absolute -bottom-0.5 -right-0.5 grid h-5 w-5 place-items-center rounded-md border border-white bg-white/95 text-slate-500 shadow-sm">
          <CategoryIcon size={11} strokeWidth={2.4} />
        </span>
      )}
    </span>
  );
}

export function ToolVisualChip({ visual }: { visual: ToolVisual }) {
  const Icon = visual.icon;

  if (visual.product) {
    const brandIcon = visual.product.simpleIcon;
    const style = brandIcon
      ? {
          color: `#${brandIcon.hex}`,
          backgroundColor: brandTint(brandIcon.hex, 0.08),
          borderColor: brandTint(brandIcon.hex, 0.2),
        }
      : undefined;

    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase ${brandIcon ? "" : visual.product.chipClass}`}
        style={style}
      >
        {brandIcon ? <BrandSvg visual={visual} size="sm" /> : <span className="font-black">{visual.product.mark}</span>}
        {visual.product.name}
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-semibold uppercase ${toolVisualPillClass(visual.tone)}`}>
      <Icon size={10} /> {visual.label}
    </span>
  );
}
