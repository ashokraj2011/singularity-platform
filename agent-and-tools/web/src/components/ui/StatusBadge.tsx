import clsx from "clsx";

export function StatusBadge({ value }: { value: string | undefined | null }) {
  if (!value) return null;
  return (
    <span className={clsx("badge", `badge-${value.toLowerCase().replace(/\s+/g, "_")}`)}>
      {value}
    </span>
  );
}
