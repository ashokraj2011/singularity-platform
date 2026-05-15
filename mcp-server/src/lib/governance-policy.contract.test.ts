import assert from "node:assert/strict";
import { outageResult } from "./audit-gov-check";
import { isDegradedToolAllowedByPolicy, isRiskyToolByPolicy } from "./governance-policy";
import type { PendingToolDescriptor } from "../audit/pending";

function desc(name: string, execution_target: "LOCAL" | "SERVER", risk_level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"): PendingToolDescriptor {
  return { name, description: name, input_schema: {}, execution_target, risk_level };
}

assert.equal(outageResult("fail_closed", "budget").allowed, false);
assert.equal(outageResult("fail_closed", "budget").unavailable, true);
assert.equal(outageResult("fail_open", "budget").allowed, true);
assert.equal(outageResult("degraded", "rate_limit").allowed, true);
assert.match(outageResult("human_approval_required", "rate_limit").reason ?? "", /restrict risky actions/);

assert.equal(isDegradedToolAllowedByPolicy("search_code", desc("search_code", "LOCAL", "LOW")), true);
assert.equal(isDegradedToolAllowedByPolicy("write_file", desc("write_file", "LOCAL", "LOW")), false);
assert.equal(isDegradedToolAllowedByPolicy("server_tool", desc("server_tool", "SERVER", "LOW")), false);
assert.equal(isDegradedToolAllowedByPolicy("get_secret", desc("get_secret", "LOCAL", "HIGH")), false);
assert.equal(isDegradedToolAllowedByPolicy("search_code", desc("search_code", "LOCAL", "LOW"), ["find_symbol"]), false);

assert.equal(isRiskyToolByPolicy("write_file", desc("write_file", "LOCAL", "LOW")), true);
assert.equal(isRiskyToolByPolicy("server_tool", desc("server_tool", "SERVER", "LOW")), true);
assert.equal(isRiskyToolByPolicy("search_code", desc("search_code", "LOCAL", "LOW")), false);

console.log("governance policy contract tests passed");
