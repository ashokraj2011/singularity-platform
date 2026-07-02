import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const COOKIE_NAME = "singularity_onboarding_state";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

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
    const parsed = JSON.parse(decoded) as Partial<OnboardingState>;
    return sanitizeState(parsed);
  } catch {
    return DEFAULT_STATE;
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 80);
}

function sanitizeState(value: Partial<OnboardingState>): OnboardingState {
  const deploymentMode = value.deploymentMode === "docker"
    || value.deploymentMode === "bare-metal"
    || value.deploymentMode === "split-runtime"
    ? value.deploymentMode
    : "unknown";
  return {
    deploymentMode,
    completedSteps: stringArray(value.completedSteps),
    dismissedTips: stringArray(value.dismissedTips),
    preferredIntent: typeof value.preferredIntent === "string" ? value.preferredIntent.slice(0, 80) : undefined,
    preferredModelAlias: typeof value.preferredModelAlias === "string" ? value.preferredModelAlias.slice(0, 80) : undefined,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
  };
}

export async function GET() {
  const store = await cookies();
  const state = parseState(store.get(COOKIE_NAME)?.value);
  return NextResponse.json({ state });
}

export async function POST(req: NextRequest) {
  let body: Partial<OnboardingState> = {};
  try {
    body = await req.json() as Partial<OnboardingState>;
  } catch {
    body = {};
  }
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
