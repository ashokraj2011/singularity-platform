import "express-async-errors";
import express from "express";
import helmet from "helmet";
import { executeInDocker, executeRequestSchema, runnerHealth } from "./docker-exec";
import { runnerConfig } from "./config";

function checkAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const header = req.header("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (token !== runnerConfig.MCP_RUNNER_TOKEN) {
    res.status(401).json({ success: false, error: "missing or invalid runner bearer token" });
    return;
  }
  next();
}

export function createRunnerApp() {
  const app = express();
  app.use(helmet());
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    const health = runnerHealth();
    res.status(health.ready ? 200 : 503).json({ success: health.ready, data: health });
  });

  app.post("/v1/execute", checkAuth, async (req, res) => {
    const parsed = executeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: "VALIDATION_ERROR", details: parsed.error.flatten() });
      return;
    }
    try {
      const receipt = await executeInDocker(parsed.data);
      res.json({ success: true, data: receipt });
    } catch (err) {
      const message = (err as Error).message;
      const status = /not allowed|escapes the sandbox|shell operators|traversal|single allowlisted executable/i.test(message)
        ? 400
        : 500;
      res.status(status).json({ success: false, error: message });
    }
  });

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ success: false, error: err.message });
  });

  return app;
}

export const app = createRunnerApp();

if (require.main === module) {
  app.listen(runnerConfig.PORT, () => {
    console.log(`[mcp-sandbox-runner] listening on :${runnerConfig.PORT}`);
  });
}
