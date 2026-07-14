import { describe, it, expect } from "vitest";
import { parseCopilotResponse, buildProposeTask, roomCopilotSystemPrompt } from "../src/modules/rooms/room-copilot";

describe("parseCopilotResponse", () => {
  it("parses claims, clamps selfEstimate, and keeps a valid claimType", () => {
    const r = parseCopilotResponse(JSON.stringify({
      reply: "Here are some framings.",
      claims: [
        { statement: "Users abandon at KYC, not pricing", riskiestAssumption: "KYC is the drop-off", claimType: "USER", selfEstimate: 0.62 },
        { statement: "Over-confident", claimType: "USER", selfEstimate: 3 }, // clamps to 1
      ],
    }));
    expect(r.reply).toBe("Here are some framings.");
    expect(r.claims).toHaveLength(2);
    expect(r.claims[0].claimType).toBe("USER");
    expect(r.claims[0].selfEstimate).toBeCloseTo(0.62, 6);
    expect(r.claims[1].selfEstimate).toBe(1);
  });

  it("drops claims with no statement and invalid claimTypes", () => {
    const r = parseCopilotResponse(JSON.stringify({
      claims: [{ statement: "", selfEstimate: 0.5 }, { statement: "Real", claimType: "BOGUS", selfEstimate: 0.4 }],
    }));
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0].statement).toBe("Real");
    expect(r.claims[0].claimType).toBeUndefined();
  });

  it("tolerates ```json fences and surrounding prose", () => {
    const r = parseCopilotResponse('Sure!\n```json\n{ "reply": "ok", "claims": [{ "statement": "X", "selfEstimate": 0.5 }] }\n```');
    expect(r.reply).toBe("ok");
    expect(r.claims[0].statement).toBe("X");
  });

  it("degrades to reply-only on non-JSON (no crash)", () => {
    const r = parseCopilotResponse("the model bridge is unreachable");
    expect(r.claims).toEqual([]);
    expect(r.reply).toContain("bridge");
  });
});

describe("buildProposeTask / system prompt", () => {
  it("includes project, mission, existing claims, and the prompt", () => {
    const task = buildProposeTask({
      projectName: "Payments Reliability",
      mission: "Cut failure rate",
      roomTitle: "Why do retries double-charge?",
      existingClaims: [{ statement: "Dedup lives in the pod" }],
      prompt: "What are we missing?",
    });
    expect(task).toContain("Payments Reliability");
    expect(task).toContain("Cut failure rate");
    expect(task).toContain("Dedup lives in the pod");
    expect(task).toContain("What are we missing?");
  });
  it("system prompt asks for a riskiest assumption + a calibrated self-estimate", () => {
    const s = roomCopilotSystemPrompt();
    expect(s).toMatch(/riskiest/i);
    expect(s).toMatch(/selfEstimate/);
  });
});
