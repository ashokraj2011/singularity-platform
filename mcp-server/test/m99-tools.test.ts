/**
 * M99 S1.2 — the six new AER tools.
 *
 * These tools compose over the AST index + sandbox (real-workspace infra), so
 * this suite covers what's verifiable WITHOUT a workspace:
 *   1. descriptor well-formedness (name/schema/risk shape)
 *   2. input_schema parity with the canonical tools.json mirror
 *   3. validation-error paths (missing required args fail BEFORE touching infra)
 * Full happy-path behavior is exercised by the integration/E2E run, not here.
 */
import { describe, expect, it, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

let M99_TOOLS: any[];

beforeAll(async () => {
  process.env.MCP_BEARER_TOKEN ??= "test-bearer-token-12345-min-16-chars";
  process.env.LLM_GATEWAY_URL ??= "http://127.0.0.1:1";
  const mod = await import("../src/tools/m99-tools");
  M99_TOOLS = mod.M99_TOOLS;
});

const EXPECTED = [
  "localize_code_change",
  "localize_test_failure",
  "replace_method_or_function",
  "insert_switch_case_or_enum_handler",
  "add_test_case",
  "git_push_preflight",
];

describe("M99 S1.2 — AER tool descriptors", () => {
  it("exports exactly the six expected tools", () => {
    expect(M99_TOOLS.map((t) => t.descriptor.name).sort()).toEqual([...EXPECTED].sort());
  });

  it("every descriptor is well-formed", () => {
    for (const t of M99_TOOLS) {
      const d = t.descriptor;
      expect(typeof d.name).toBe("string");
      expect(d.name.length).toBeGreaterThan(0);
      expect(typeof d.description).toBe("string");
      expect(typeof d.natural_language).toBe("string");
      expect(d.input_schema).toBeTruthy();
      expect((d.input_schema as any).type).toBe("object");
      expect(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).toContain(d.risk_level);
      expect(typeof d.requires_approval).toBe("boolean");
      expect(typeof t.execute).toBe("function");
    }
  });

  it("input_schema required fields match the canonical tools.json mirror", () => {
    const canonical = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../../agent-and-tools/packages/tool-registry/src/tools.json"),
        "utf8",
      ),
    ).tools;
    for (const t of M99_TOOLS) {
      const name = t.descriptor.name;
      expect(canonical[name], `tools.json missing ${name}`).toBeTruthy();
      const jsonReq = ((canonical[name].input_schema?.required) ?? []).slice().sort();
      const descReq = (((t.descriptor.input_schema as any).required) ?? []).slice().sort();
      expect(descReq, `required mismatch for ${name}`).toEqual(jsonReq);
    }
  });
});

describe("M99 S1.2 — validation guards (no workspace needed)", () => {
  function tool(name: string) {
    return M99_TOOLS.find((t) => t.descriptor.name === name)!;
  }

  it("localize_code_change rejects missing task", async () => {
    const r = await tool("localize_code_change").execute({});
    expect(r.success).toBe(false);
    expect(r.error_code).toBe("VALIDATION");
  });

  it("localize_test_failure rejects missing failure_output", async () => {
    const r = await tool("localize_test_failure").execute({});
    expect(r.success).toBe(false);
    expect(r.error_code).toBe("VALIDATION");
  });

  it("replace_method_or_function rejects missing args", async () => {
    const r = await tool("replace_method_or_function").execute({ path: "a.ts", symbol: "foo" });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe("VALIDATION");
  });

  it("insert_switch_case_or_enum_handler rejects missing args", async () => {
    const r = await tool("insert_switch_case_or_enum_handler").execute({ path: "a.ts", anchor: "Sw" });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe("VALIDATION");
  });

  it("add_test_case rejects missing test_body", async () => {
    const r = await tool("add_test_case").execute({ path: "a.test.ts", test_name: "x" });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe("VALIDATION");
  });
});
