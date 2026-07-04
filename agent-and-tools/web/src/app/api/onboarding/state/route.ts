import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { readRequestJson } from "../../_json";

export const dynamic = "force-dynamic";

const COOKIE_NAME = "singularity_onboarding_state";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 180;
const DEPLOYMENT_MODES = new Set(["docker", "bare-metal", "split-runtime", "unknown"]);

type OnboardingState = {
  deploymentMode: "docker" | "bare-metal" | "split-runtime" | "unknown";
  completedSteps: string[];
  dismissedTips: string[];
  preferredIntent?: string;
  preferredModelAlias?: string;
  updatedAt?: string;
};

const DEFAULT_STATE: OnboardingState = {
  deploymentMode: "unknown",
  completedSteps: [],
  dismissedTips: [],
};

function parseState(raw?: string): OnboardingState {
  if (!raw) return DEFAULT_STATE;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    return sanitizeState(parsed);
  } catch {
    return DEFAULT_STATE;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  const text = typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  return text || undefined;
}

function stringArray(value: unknown, maxItems = 80, maxLength = 120): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map((item) => boundedString(item, maxLength))
      .filter((item): item is string => Boolean(item)),
  )].slice(0, maxItems);
}

function timestampString(value: unknown): string | undefined {
  const text = boundedString(value, 40);
  if (!text) return undefined;
  return Number.isNaN(Date.parse(text)) ? undefined : text;
}

function deploymentMode(value: unknown): OnboardingState["deploymentMode"] {
  return typeof value === "string" && DEPLOYMENT_MODES.has(value)
    ? value as OnboardingState["deploymentMode"]
    : "unknown";
}

function sanitizeState(value: unknown): OnboardingState {
  const record = isRecord(value) ? value : {};
  return {
    deploymentMode: deploymentMode(record.deploymentMode),
    completedSteps: stringArray(record.completedSteps),
    dismissedTips: stringArray(record.dismissedTips),
    preferredIntent: boundedString(record.preferredIntent, 80),
    preferredModelAlias: boundedString(record.preferredModelAlias, 80),
    updatedAt: timestampString(record.updatedAt),
  };
}

export async function GET() {
  const store = await cookies();
  const state = parseState(store.get(COOKIE_NAME)?.value);
  return NextResponse.json({ state });
}

export async function POST(req: NextRequest) {
  const requestBody = await readRequestJson(req);
  if (requestBody.parseError) {
    return NextResponse.json(
      { code: "INVALID_JSON", message: "Request body must be valid JSON.", detail: requestBody.text },
      { status: 400 },
    );
  }
  const body = isRecord(requestBody.data) ? requestBody.data : {};
  const store = await cookies();
  const current = parseState(store.get(COOKIE_NAME)?.value);
  const state = sanitizeState({ ...current, ...body, updatedAt: new Date().toISOString() });
  const encoded = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  const res = NextResponse.json({ state });
  res.cookies.set(COOKIE_NAME, encoded, {
    path: "/",
    sameSite: "lax",
    maxAge: MAX_AGE_SECONDS,
  });
  return res;
}
