#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function loadWs() {
  try {
    return require("ws");
  } catch {
    return require(path.join(ROOT, "mcp-server/node_modules/ws"));
  }
}

const WebSocket = loadWs();
const BASE_URL = process.env.PLATFORM_WEB_BASE_URL ?? "http://localhost:5180";
const CDP_COMMAND_TIMEOUT_MS = Number(process.env.PLATFORM_WEB_UI_CDP_TIMEOUT_MS ?? 10_000);
const CHECK_TIMEOUT_MS = Number(process.env.PLATFORM_WEB_UI_CHECK_TIMEOUT_MS ?? 45_000);
const SUITE_TIMEOUT_MS = Number(process.env.PLATFORM_WEB_UI_SUITE_TIMEOUT_MS ?? 360_000);
const bootstrapCredentials = (() => {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, ".singularity/config.local.json"), "utf8"));
    return {
      email: parsed?.identity?.bootstrapEmail || "admin@singularity.local",
      password: parsed?.identity?.bootstrapPassword || "Admin1234!",
    };
  } catch {
    return { email: "admin@singularity.local", password: "Admin1234!" };
  }
})();
const CHROME_BIN =
  process.env.CHROME_BIN ??
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((candidate) => fs.existsSync(candidate));

if (!CHROME_BIN) {
  console.error("FAIL Chrome was not found. Set CHROME_BIN to run the Platform Web UI smoke check.");
  process.exit(1);
}

const checks = [
  {
    name: "sdlc command center",
    path: "/",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        return {
          ok: /SDLC Command Center/i.test(text) && /Delivery Loop/i.test(text) && /Evidence Rail/i.test(text) && /Create Agent/i.test(text) && !/Unexpected token|Internal Server Error/i.test(text),
          detail: text.slice(0, 300)
        };
      })()
    `,
  },
  {
    name: "main navigation workgraph menu",
    path: "/",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        return {
          ok: /Workflow Operations/i.test(text) && /Workflow Authoring/i.test(text) && /Work Hub/i.test(text) && /Metadata/i.test(text) && /Artifact Studio/i.test(text) && /Node Types/i.test(text) && /Connectors/i.test(text) && /Eval Curation/i.test(text),
          detail: text.slice(0, 360)
        };
      })()
    `,
  },
  {
    name: "unified app catalog",
    path: "/control-plane",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        return {
          ok: /Singularity Command Center/i.test(text) && /Agent Studio/i.test(text) && /Workflows/i.test(text) && /Workbench/i.test(text) && /Foundry/i.test(text) && /Identity/i.test(text) && !/Could not load|Unexpected token|Internal Server Error/i.test(text),
          detail: text.slice(0, 300)
        };
      })()
    `,
  },
  {
    name: "workflow templates",
    path: "/workflows/templates",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        return {
          ok: /Workflow Manager/i.test(text) && /New Workflow|Workflows|Runs/i.test(text) && !/Could not load this surface|Unexpected token/i.test(text),
          detail: text.slice(0, 240)
        };
      })()
    `,
  },
  {
    name: "workflow create dialog",
    path: "/workflows/templates",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        if (!/Configure metadata before designing the flow/i.test(text)) {
          const buttons = Array.from(document.querySelectorAll("button"));
          const button = buttons.find((item) => /New workflow/i.test(item.innerText || ""));
          if (button) button.click();
        }
        const nextText = document.body?.innerText || "";
        return {
          ok: /Configure metadata before designing the flow/i.test(nextText) && /Workflow name/i.test(nextText) && /Starter pattern/i.test(nextText),
          detail: nextText.slice(0, 260)
        };
      })()
    `,
  },
  {
    name: "workflow designer React Flow",
    path: "/workflows/design/30000000-0000-0000-0000-000000000012",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        const flow = document.querySelector(".react-flow");
        const nodes = document.querySelectorAll(".react-flow__node").length;
        return {
          ok: Boolean(flow) && nodes > 0 && !/Could not load|Unexpected token/i.test(text),
          detail: "react-flow=" + Boolean(flow) + " nodes=" + nodes + " text=" + text.slice(0, 180)
        };
      })()
    `,
  },
  {
    name: "workflow planner",
    path: "/workflows/planner",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        return {
          ok: /Planner|Idea Inbox|Active Roadmap/i.test(text) && !/Could not load|Unexpected token|Internal Server Error/i.test(text),
          detail: text.slice(0, 260)
        };
      })()
    `,
  },
  {
    name: "workflow inbox",
    path: "/workflows/inbox",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        return {
          ok: /Inbox/i.test(text) && /Mine|Available|Done|New WorkItem/i.test(text) && !/Could not load|Unexpected token|Internal Server Error/i.test(text),
          detail: text.slice(0, 260)
        };
      })()
    `,
  },
  {
    name: "runs dashboard",
    path: "/runs",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        return {
          ok: /Runs/i.test(text) && /Start a run|Workflow|server/i.test(text) && !/Could not load|Unexpected token/i.test(text),
          detail: text.slice(0, 240)
        };
      })()
    `,
  },
  {
    name: "workflow start dialog",
    path: "/workflows/run",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        if (!/WorkItem input/i.test(text)) {
          const buttons = Array.from(document.querySelectorAll("button"));
          const button = buttons.find((item) => /Start from WorkItem/i.test(item.innerText || ""));
          if (button) button.click();
        }
        const nextText = document.body?.innerText || "";
        const buttonText = Array.from(document.querySelectorAll("button")).map((item) => (item.innerText || "").trim()).filter(Boolean).slice(0, 24).join(" | ");
        return {
          ok: /Start workflow/i.test(nextText) && /WorkItem input/i.test(nextText) && /Select an unattached WorkItem|No unattached WorkItems|Attach a capability/i.test(nextText),
          detail: nextText.slice(0, 260) + " buttons=" + buttonText
        };
      })()
    `,
  },
  {
    name: "workitems board",
    path: "/work-items",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        return {
          ok: /WorkItems/i.test(text) && /New WorkItem/i.test(text) && /Existing WorkItems|Route business work|Search WorkItems/i.test(text) && !/Could not load|Unexpected token|Internal Server Error/i.test(text),
          detail: text.slice(0, 260)
        };
      })()
    `,
  },
  {
    name: "artifact designer",
    path: "/workflows/artifacts",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        return {
          ok: /Artifact Studio/i.test(text) && /New artifact|Create first artifact|contracts, deliverables & specs/i.test(text) && !/Could not load|Unexpected token/i.test(text),
          detail: text.slice(0, 240)
        };
      })()
    `,
  },
  {
    name: "artifact editor",
    path: "/workflows/artifacts/abc",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        return {
          ok: /Artifacts/i.test(text) && /Sections/i.test(text) && /Preview/i.test(text) && /Save/i.test(text) && !/Could not load|Unexpected token|Internal Server Error/i.test(text),
          detail: text.slice(0, 260)
        };
      })()
    `,
  },
  {
    name: "artifact create dialog",
    path: "/workflows/artifacts",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        if (!/New Artifact Template/i.test(text)) {
          const buttons = Array.from(document.querySelectorAll("button"));
          const button = buttons.find((item) => /New artifact|Create first artifact/i.test(item.innerText || ""));
          if (button) button.click();
        }
        const nextText = document.body?.innerText || "";
        return {
          ok: /New Artifact Template/i.test(nextText) && /Deliverable|Specification|Contract/i.test(nextText),
          detail: nextText.slice(0, 260)
        };
      })()
    `,
  },
  {
    name: "custom node types",
    path: "/workflows/node-types",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        return {
          ok: /Node Type Designer/i.test(text) && /New node type|Create your first node type|Workflow Manager palette/i.test(text) && !/Could not load|Unexpected token/i.test(text),
          detail: text.slice(0, 240)
        };
      })()
    `,
  },
  {
    name: "custom node type designer panel",
    path: "/workflows/node-types",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        if (!/New custom node type/i.test(text)) {
          const buttons = Array.from(document.querySelectorAll("button"));
          const button = buttons.find((item) => /New node type|Create your first node type/i.test(item.innerText || ""));
          if (button) button.click();
        }
        const nextText = document.body?.innerText || "";
        const buttonText = Array.from(document.querySelectorAll("button")).map((item) => (item.innerText || "").trim()).filter(Boolean).slice(0, 24).join(" | ");
        return {
          ok: /Create node type/i.test(nextText) && /Add field/i.test(nextText) && /Human Task/i.test(nextText),
          detail: nextText.slice(0, 260) + " buttons=" + buttonText
        };
      })()
    `,
  },
  {
    name: "blueprint workbench",
    path: "/workbench",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        const authGateOk = /Blueprint Workbench/i.test(text) && /Open Platform Login/i.test(text) && !/Continue as super admin/i.test(text);
        const shellOk = /Blueprint Workbench|Workbench Neo|Create session|Create Workbench Session/i.test(text);
        return {
          ok: (authGateOk || shellOk) && !/Could not load Workbench|Unexpected token/i.test(text),
          detail: text.slice(0, 240)
        };
      })()
    `,
  },
  {
    name: "blueprint workbench cockpit",
    path: "/workbench/cockpit",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        const cockpitOk = /Story-to-Delivery Workbench/i.test(text) && /Blueprint Workbench/i.test(text) && /Loop|Replay|Theater/i.test(text) && /Stage|Iterations|Guided Delivery Intake/i.test(text);
        return {
          ok: cockpitOk && !/Application error|client-side exception|Could not load this surface|Unexpected token|Internal Server Error/i.test(text),
          detail: text.slice(0, 300)
        };
      })()
    `,
  },
  {
    name: "operations readiness",
    path: "/operations/readiness",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        return {
          ok: /Platform Readiness/i.test(text) && /Core Platform Services/i.test(text) && /Runtime Infrastructure/i.test(text) && /Prompt Composer/i.test(text) && !/Could not load|Unexpected token|Internal Server Error/i.test(text),
          detail: text.slice(0, 260)
        };
      })()
    `,
  },
  {
    name: "audit curation",
    path: "/audit/curation",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        return {
          ok: /Eval Curation/i.test(text) && /datasets|review candidate examples/i.test(text) && !/Could not load|Unexpected token|Internal Server Error/i.test(text),
          detail: text.slice(0, 260)
        };
      })()
    `,
  },
  {
    name: "agent studio shell",
    path: "/agents/studio",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        return {
          ok: /Agent Studio/i.test(text) && /Governed templates/i.test(text) && /Create Agent/i.test(text) && /Capability scope|Sign in for governed agent changes/i.test(text) && !/Could not load|Unexpected token|Internal Server Error|port 3000/i.test(text),
          detail: text.slice(0, 260)
        };
      })()
    `,
  },
  {
    name: "agent studio source-backed skill wizard",
    path: "/agents/studio",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        if (!/Create a capability-scoped draft with source-backed skills/i.test(text)) {
          const buttons = Array.from(document.querySelectorAll("button"));
          const button = buttons.find((item) => /^\\s*Create Agent\\s*$/i.test(item.innerText || ""));
          if (button) button.click();
        }
        const buttons = Array.from(document.querySelectorAll("button"));
        const skillsButton = buttons.find((item) => /3\\.\\s*Skills/i.test(item.innerText || ""));
        if (skillsButton) skillsButton.click();
        const nextText = document.body?.innerText || "";
        return {
          ok: /Provider\\/API manifest/i.test(nextText) && /Document URL/i.test(nextText) && /Upload files/i.test(nextText) && /Add read-only link/i.test(nextText) && /Supports \\.txt, \\.md, \\.pdf, \\.docx, \\.xlsx, and \\.pptx/i.test(nextText) && !/Could not load|Unexpected token|Internal Server Error/i.test(nextText),
          detail: nextText.slice(0, 320)
        };
      })()
    `,
  },
  {
    name: "prompt workbench",
    path: "/prompt-workbench",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        return {
          ok: /Prompt Workbench/i.test(text) && /Run Preview/i.test(text) && /Composed prompt preview/i.test(text) && /Context plan/i.test(text) && !/Could not load|Unexpected token|Internal Server Error/i.test(text),
          detail: text.slice(0, 260)
        };
      })()
    `,
  },
  {
    name: "code foundry cockpit",
    path: "/foundry",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        return {
          ok: /Code Foundry/i.test(text) && /Generation Cockpit/i.test(text) && /greenfield|brownfield/i.test(text) && /No Code Foundry runs found|Overview|Code Foundry API is not running locally|protected files/i.test(text) && !/Unexpected token|Internal Server Error|--profile foundry/i.test(text),
          detail: text.slice(0, 300)
        };
      })()
    `,
  },
  {
    name: "code foundry history lifecycle",
    path: "/foundry/history",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        return {
          ok: /Code Foundry/i.test(text) && /Run History/i.test(text) && /Generation History/i.test(text) && /Spec Lifecycle/i.test(text) && !/Unexpected token|Internal Server Error|--profile foundry/i.test(text),
          detail: text.slice(0, 320)
        };
      })()
    `,
  },
  {
    name: "singularity engine",
    path: "/engine",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        return {
          ok: /Singularity Engine/i.test(text) && /Run Sweep/i.test(text) && /Issues/i.test(text) && /Active Evaluators/i.test(text) && !/Could not load|Unexpected token|Internal Server Error/i.test(text),
          detail: text.slice(0, 300)
        };
      })()
    `,
  },
  {
    name: "identity surface",
    path: "/identity",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        return {
          ok: ((/Identity Dashboard|Identity and Capability Administration/i.test(text) && /Users/i.test(text) && /Teams/i.test(text) && /Capabilities/i.test(text) && /Permissions/i.test(text)) || (/Welcome back/i.test(text) && /IAM Platform/i.test(text) && /Sign In/i.test(text))) && !/Could not load IAM data|Unexpected token|Internal Server Error/i.test(text),
          detail: text.slice(0, 300)
        };
      })()
    `,
  },
  {
    name: "identity variables",
    path: "/identity/variables",
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        return {
          ok: /Variables/i.test(text) && /New variable|No variables|constants referenced/i.test(text) && !/Could not load|Unexpected token|Internal Server Error/i.test(text),
          detail: text.slice(0, 260)
        };
      })()
    `,
  },
  {
    name: "global login next route",
    path: "/identity/login?next=/agents/studio",
    expression: `
      (async () => {
        const tokenStores = ["agent-tools-token", "iam-auth", "singularity-portal.auth", "workgraph-auth"];
        if (window.location.pathname === "/agents/studio") {
          const missing = tokenStores.filter((key) => !localStorage.getItem(key));
          return {
            ok: missing.length === 0 && /Agent Studio/i.test(document.body?.innerText || ""),
            detail: "path=" + window.location.pathname + " missing=" + (missing.join(",") || "none")
          };
        }
        const text = document.body?.innerText || "";
        if (!/IAM Platform|Sign In|SINGULARITY/i.test(text)) {
          return { ok: false, detail: "waiting for login page: " + text.slice(0, 180) };
        }
        if (!sessionStorage.getItem("singularity-login-next-submitted")) {
          for (const key of tokenStores) localStorage.removeItem(key);
          const email = document.querySelector('input[placeholder="email"], input[type="email"]');
          const password = document.querySelector('input[placeholder="password"], input[type="password"]');
          const setValue = (input, value) => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
            setter.call(input, value);
            input.dispatchEvent(new Event("input", { bubbles: true }));
          };
          if (!email || !password) return { ok: false, detail: "login inputs not found" };
          setValue(email, ${JSON.stringify(bootstrapCredentials.email)});
          setValue(password, ${JSON.stringify(bootstrapCredentials.password)});
          sessionStorage.setItem("singularity-login-next-submitted", "1");
          document.querySelector("form")?.requestSubmit();
          return { ok: false, detail: "submitted login form" };
        }
        return { ok: false, detail: "waiting after submit path=" + window.location.pathname + " text=" + text.slice(0, 180) };
      })()
    `,
  },
];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForProcessExit(child, timeoutMs = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Could not parse JSON from ${url}: ${err.message}; body=${data.slice(0, 200)}`));
        }
      });
    });
    req.setTimeout(options.timeoutMs ?? 15_000, () => {
      req.destroy(new Error(`HTTP request timed out for ${url}`));
    });
    req.on("error", reject);
    req.end();
  });
}

function firstArray(data, keys = ["content", "items", "data", "runs", "instances"]) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const key of keys) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

async function discoverWorkflowRunId() {
  try {
    const data = await requestJson(`${BASE_URL.replace(/\/$/, "")}/api/workgraph/workflow-instances?size=1`);
    const run = firstArray(data).find((item) => item && typeof item.id === "string");
    return run?.id ?? null;
  } catch (err) {
    console.warn(`WARN Could not discover a workflow run for deep-link smoke: ${err.message}`);
    return null;
  }
}

async function waitForVersion(port) {
  const url = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      return await requestJson(url);
    } catch {
      await sleep(250);
    }
  }
  throw new Error("Chrome remote debugging endpoint did not start");
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    this.ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method && this.events.has(msg.method)) {
        for (const cb of this.events.get(msg.method)) cb(msg.params);
      }
    });
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await withTimeout(new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    }), CDP_COMMAND_TIMEOUT_MS, "CDP websocket open");
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    const command = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
    return withTimeout(command, CDP_COMMAND_TIMEOUT_MS, `CDP ${method}`);
  }

  on(method, cb) {
    const current = this.events.get(method) ?? [];
    current.push(cb);
    this.events.set(method, current);
  }

  close() {
    this.ws.close();
  }
}

async function createPage(port) {
  const target = await requestJson(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  const page = new Cdp(target.webSocketDebuggerUrl);
  await page.open();
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  return page;
}

async function navigateAndWait(page, url, expression) {
  const load = new Promise((resolve) => page.on("Page.loadEventFired", resolve));
  await page.send("Page.navigate", { url });
  await Promise.race([load, sleep(12_000)]);

  const deadline = Date.now() + 20_000;
  let last = "no result";
  while (Date.now() < deadline) {
    const result = await page.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const value = result.result?.value;
    if (value?.ok) return value.detail ?? "ok";
    last = value?.detail ?? JSON.stringify(result.result ?? {});
    await sleep(750);
  }
  throw new Error(last);
}

async function seedBrowserSession(page) {
  const base = BASE_URL.replace(/\/$/, "");
  const load = new Promise((resolve) => page.on("Page.loadEventFired", resolve));
  await page.send("Page.navigate", { url: `${base}/identity/login` });
  await Promise.race([load, sleep(12_000)]);

  const expression = `
    (async () => {
      const response = await fetch("/api/iam/auth/local/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(${JSON.stringify(bootstrapCredentials)})
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.access_token) {
        return { ok: false, detail: "login failed: " + response.status + " " + JSON.stringify(body).slice(0, 220) };
      }
      const persisted = JSON.stringify({
        state: { token: body.access_token, user: body.user ?? null },
        version: 0
      });
      localStorage.setItem("iam-auth", persisted);
      localStorage.setItem("singularity-portal.auth", persisted);
      localStorage.setItem("workgraph-auth", persisted);
      localStorage.setItem("agent-tools-token", body.access_token);
      return { ok: true, detail: body.user?.email || "authenticated" };
    })()
  `;
  const result = await page.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const value = result.result?.value;
  if (!value?.ok) throw new Error(value?.detail ?? "could not seed browser auth session");
  return value.detail;
}

const discoveredRunId = await discoverWorkflowRunId();
if (discoveredRunId) {
  checks.splice(4, 0, {
    name: "workflow run detail",
    path: `/runs/${discoveredRunId}`,
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        const flow = document.querySelector(".react-flow");
        return {
          ok: /Timeline/i.test(text) && (/COMPLETED|ACTIVE|PAUSED|FAILED|CANCELLED/i.test(text)) && (Boolean(flow) || /Graph view|Step timeline|Mission Control|Artifacts/i.test(text)) && !/Run not found|Could not load|Unexpected token|Internal Server Error/i.test(text),
          detail: "react-flow=" + Boolean(flow) + " text=" + text.slice(0, 260)
        };
      })()
    `,
  });
  checks.splice(5, 0, {
    name: "workflow run artifacts",
    path: `/runs/${discoveredRunId}/artifacts`,
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        return {
          ok: /Run artifacts/i.test(text) && (/artifact|hasn.t produced any artifacts yet/i.test(text)) && !/Run not found|Could not load artifacts|Unexpected token|Internal Server Error/i.test(text),
          detail: text.slice(0, 260)
        };
      })()
    `,
  });
  checks.splice(6, 0, {
    name: "workflow run insights",
    path: `/runs/${discoveredRunId}/insights`,
    expression: `
      (() => {
        const text = document.body?.innerText || "";
        return {
          ok: /Run Insights|Mission Control|Evidence|Audit|Timeline|Live events/i.test(text) && !/Run not found|Could not load|Unexpected token|Internal Server Error/i.test(text),
          detail: text.slice(0, 260)
        };
      })()
    `,
  });
}

const port = await freePort();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "singularity-platform-web-ui-"));
const chrome = spawn(CHROME_BIN, [
  "--headless=new",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1440,1100",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

const suiteTimer = setTimeout(() => {
  console.error(`FAIL Platform Web UI smoke suite timed out after ${SUITE_TIMEOUT_MS}ms`);
  if (stderr.trim()) console.error(stderr.trim().split("\n").slice(-8).join("\n"));
  chrome.kill("SIGTERM");
  fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(124);
}, SUITE_TIMEOUT_MS);

let stderr = "";
chrome.stderr.on("data", (chunk) => {
  stderr += String(chunk);
});

let page;
let failures = 0;
try {
  await waitForVersion(port);
  page = await createPage(port);
  const authDetail = await seedBrowserSession(page);
  console.log(`OK   seeded browser auth session (${authDetail})`);

  for (const check of checks) {
    const url = `${BASE_URL.replace(/\/$/, "")}${check.path}`;
    try {
      const detail = await withTimeout(navigateAndWait(page, url, check.expression), CHECK_TIMEOUT_MS, `${check.name} ${check.path}`);
      console.log(`OK   ${check.name} ${check.path} (${detail.replace(/\s+/g, " ").slice(0, 160)})`);
    } catch (err) {
      failures += 1;
      console.error(`FAIL ${check.name} ${check.path}: ${err.message}`);
    }
  }
} finally {
  if (page) page.close();
  chrome.kill("SIGTERM");
  await waitForProcessExit(chrome);
  fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  clearTimeout(suiteTimer);
}

if (failures) {
  if (stderr.trim()) console.error(stderr.trim().split("\n").slice(-8).join("\n"));
  console.error(`\n${failures} Platform Web UI smoke check(s) failed.`);
  process.exit(1);
}

console.log("\nPlatform Web UI smoke checks passed.");
process.exit(0);
