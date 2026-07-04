export type BoundedIntegerOptions = {
  defaultValue: number;
  min: number;
  max: number;
};

function validBounds(options: BoundedIntegerOptions): boolean {
  return (
    Number.isFinite(options.defaultValue)
    && Number.isFinite(options.min)
    && Number.isFinite(options.max)
    && options.min <= options.defaultValue
    && options.defaultValue <= options.max
  );
}

export function boundedInteger(raw: string | number | undefined, options: BoundedIntegerOptions): number {
  if (!validBounds(options)) {
    throw new Error("invalid bounded integer options");
  }
  if (raw === undefined) return options.defaultValue;
  const value = typeof raw === "number" ? raw : Number(raw.trim());
  if (!Number.isFinite(value) || value < options.min) return options.defaultValue;
  return Math.min(options.max, Math.trunc(value));
}

export function boundedEnvInteger(name: string, options: BoundedIntegerOptions): number {
  return boundedInteger(process.env[name], options);
}
