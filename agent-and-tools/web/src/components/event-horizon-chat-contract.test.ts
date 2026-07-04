import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "src/components/EventHorizonChat.tsx"), "utf8");

assert.match(
  source,
  /const ACTION_INTENTS = new Set<ActionIntent>\(\[[\s\S]*?"explain_capability"[\s\S]*?"find_runtime_evidence"[\s\S]*?"draft_review_note"[\s\S]*?"recommend_agent_team"[\s\S]*?"explain_prompt_stack"/,
  "Event Horizon should keep an explicit allow-list of supported quick-action intents",
);

assert.match(
  source,
  /function isChatMessage\(value: unknown\): value is ChatMessage[\s\S]*?value\.role === "assistant" \|\| value\.role === "user"[\s\S]*?typeof value\.text === "string"[\s\S]*?typeof value\.createdAt === "string"/,
  "Event Horizon should validate stored chat messages before restoring browser session state",
);

assert.match(
  source,
  /function parseStoredMessages\(raw: string\): ChatMessage\[\][\s\S]*?JSON\.parse\(raw\) as unknown[\s\S]*?parsed\.filter\(isChatMessage\)\.slice\(-50\)[\s\S]*?catch/,
  "Event Horizon should safely parse and bound restored local chat history",
);

assert.match(
  source,
  /function isEventHorizonActionRow\(value: unknown\): value is EventHorizonActionRow[\s\S]*?isActionIntent\(value\.intent\)[\s\S]*?typeof value\.prompt === "string"[\s\S]*?Number\.isFinite\(value\.displayOrder\)/,
  "Event Horizon should validate fetched quick-action rows before rendering buttons",
);

assert.match(
  source,
  /\.then\(\(data\) => setActions\(parseActionCatalog\(data\)\)\)/,
  "Event Horizon action catalog should use the shape guard before mutating UI state",
);

assert.match(
  source,
  /const parsed = parseStoredMessages\(raw\);[\s\S]*?if \(parsed\.length\) \{[\s\S]*?setMessages\(parsed\);/,
  "Event Horizon should restore only validated stored messages",
);

assert.doesNotMatch(
  source,
  /JSON\.parse\(raw\) as ChatMessage\[\]/,
  "Event Horizon should not cast arbitrary localStorage JSON into chat messages",
);

assert.doesNotMatch(
  source,
  /sendAction\(action\.intent as ActionIntent/,
  "Event Horizon should not cast arbitrary fetched intents into ActionIntent",
);

console.log("event horizon chat contract tests passed");
