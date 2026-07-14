/**
 * Room copilot — the pure prompt/parse for the AI-as-a-peer. It proposes candidate hypotheses
 * (claims), each with its *riskiest assumption* and a calibrated self-estimate of P(true). Diverse
 * framings, honest uncertainty. No I/O — mirrors the Agent Storm spec-agent template. The human is
 * always the steward; the copilot proposes and estimates as a peer, never decides.
 */

export type CandidateClaimType = "MARKET" | "USER" | "OPERATIONAL" | "TECHNICAL";

export interface CandidateClaim {
  statement: string;
  riskiestAssumption?: string;
  claimType?: CandidateClaimType;
  selfEstimate: number; // 0..1, the copilot's own P(true)
  rationale?: string;
}
export interface CopilotResult {
  reply: string;
  claims: CandidateClaim[];
}

const VALID_TYPES: CandidateClaimType[] = ["MARKET", "USER", "OPERATIONAL", "TECHNICAL"];

export function roomCopilotSystemPrompt(): string {
  return [
    "You are a peer participant in a discovery ROOM — the ambiguity regime of software, BEFORE a spec exists.",
    "Your job is NOT to write requirements. It is to surface candidate HYPOTHESES (claims) about the problem,",
    "the users, the market, and the system — especially framings a group anchored on the first obvious idea would miss.",
    "",
    "For each claim give: the claim as a falsifiable statement; its single RISKIEST ASSUMPTION (what, if false,",
    "collapses it); a claimType (MARKET | USER | OPERATIONAL | TECHNICAL); and selfEstimate — your calibrated",
    "probability (0..1) that the claim is TRUE. Be honestly uncertain: reserve 0.9+ for near-certainties and",
    "spread estimates to reflect real doubt. Favor DIVERSE, structurally distinct framings over minor variations.",
    "",
    "Respond with STRICT JSON only, no prose outside it:",
    '{ "reply": "<one or two sentences to the room>", "claims": [',
    '  { "statement": "...", "riskiestAssumption": "...", "claimType": "USER", "selfEstimate": 0.6, "rationale": "..." }',
    "] }",
  ].join("\n");
}

export function buildProposeTask(ctx: {
  projectName?: string | null;
  mission?: string | null;
  roomTitle?: string | null;
  existingClaims?: { statement: string }[];
  prompt: string;
}): string {
  const lines: string[] = [];
  lines.push(`PROJECT: ${ctx.projectName ?? "(untitled)"}`);
  if (ctx.mission) lines.push(`MISSION: ${ctx.mission}`);
  if (ctx.roomTitle) lines.push(`ROOM: ${ctx.roomTitle}`);
  if (ctx.existingClaims?.length) {
    lines.push("", "CLAIMS ALREADY ON THE BOARD (do not duplicate; diverge from these):");
    for (const c of ctx.existingClaims.slice(0, 30)) lines.push(`- ${c.statement}`);
  }
  lines.push("", "THE ROOM ASKS:", ctx.prompt.trim());
  lines.push("", "Propose 3–6 diverse candidate claims as STRICT JSON.");
  return lines.join("\n");
}

function clamp01(x: number): number {
  return typeof x === "number" && Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0.5;
}

export function parseCopilotResponse(text: string): CopilotResult {
  const raw = extractJson(text);
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { reply: text.trim().slice(0, 2000), claims: [] };
  }
  const reply = typeof obj.reply === "string" ? obj.reply : "";
  const rawClaims = Array.isArray(obj.claims) ? obj.claims : [];
  const claims: CandidateClaim[] = [];
  for (const c of rawClaims) {
    if (!c || typeof c !== "object") continue;
    const rec = c as Record<string, unknown>;
    const statement = typeof rec.statement === "string" ? rec.statement.trim() : "";
    if (!statement) continue;
    const type = typeof rec.claimType === "string" && (VALID_TYPES as string[]).includes(rec.claimType) ? (rec.claimType as CandidateClaimType) : undefined;
    claims.push({
      statement,
      riskiestAssumption: typeof rec.riskiestAssumption === "string" ? rec.riskiestAssumption.trim() : undefined,
      claimType: type,
      selfEstimate: clamp01(rec.selfEstimate as number),
      rationale: typeof rec.rationale === "string" ? rec.rationale.trim() : undefined,
    });
  }
  return { reply, claims };
}

/** Tolerate ```json fences and surrounding prose — pull the outermost JSON object. */
function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body.trim();
}
