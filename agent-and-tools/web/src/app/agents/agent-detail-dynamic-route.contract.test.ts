import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const route = fs.readFileSync(path.join(process.cwd(), "src/app/agents/[uid]/page.tsx"), "utf8");
const client = fs.readFileSync(path.join(process.cwd(), "src/app/agents/[uid]/AgentDetailClient.tsx"), "utf8");

assert.doesNotMatch(
  route,
  /"use client"/,
  "dynamic agent detail route should stay a server wrapper so Next build can collect it reliably",
);

assert.match(
  route,
  /export const dynamic = "force-dynamic";/,
  "agent detail route should be explicitly dynamic and avoid static page-data collection surprises",
);

assert.match(
  route,
  /params.*Promise<\{ uid: string \}>[\s\S]*?const \{ uid \} = await params;[\s\S]*?<AgentDetailClient uid=\{decodeURIComponent\(uid\)\}/,
  "agent detail route should decode the dynamic uid server-side and pass it to the client component",
);

assert.match(
  client,
  /^"use client";/,
  "agent detail interaction should remain in a client component",
);

assert.doesNotMatch(
  client,
  /useParams\(/,
  "agent detail client should receive uid from the server wrapper instead of reading route params itself",
);

console.log("agent detail dynamic route contract tests passed");
