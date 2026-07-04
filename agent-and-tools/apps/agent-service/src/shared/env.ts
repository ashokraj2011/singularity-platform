export type BoundedIntegerOptions = {
  defaultValue: number;
  min: number;
  max: number;
};

export type BoundedNumberOptions = BoundedIntegerOptions;

function validBounds(options: BoundedNumberOptions): boolean {
  return (
    Number.isFinite(options.defaultValue)
    && Number.isFinite(options.min)
    && Number.isFinite(options.max)
    && options.min <= options.defaultValue
    && options.defaultValue <= options.max
  );
}

function finiteNumber(raw: string | number | undefined): number | null {
  if (raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (raw.trim() === "") return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}

export function boundedNumber(raw: string | number | undefined, options: BoundedNumberOptions): number {
  if (!validBounds(options)) {
    throw new Error("invalid bounded number options");
  }
  const value = finiteNumber(raw);
  if (value === null || value < options.min) return options.defaultValue;
  return Math.min(options.max, value);
}

export function boundedEnvNumber(name: string, options: BoundedNumberOptions): number {
  return boundedNumber(process.env[name], options);
}

export function boundedInteger(raw: string | number | undefined, options: BoundedIntegerOptions): number {
  if (!validBounds(options)) {
    throw new Error("invalid bounded integer options");
  }
  return Math.trunc(boundedNumber(raw, options));
}

export function boundedEnvInteger(name: string, options: BoundedIntegerOptions): number {
  return boundedInteger(process.env[name], options);
}
