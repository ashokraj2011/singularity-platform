import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const controller = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.controller.ts"), "utf8");
const routes = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.routes.ts"), "utf8");
const service = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/world-model.service.ts"), "utf8");

assert.match(
  controller,
  /import \{ ConflictError, ForbiddenError \} from "\.\.\/\.\.\/shared\/errors";[\s\S]*?async function assertCapabilityMutable\([\s\S]*?capabilityService\.get\(capabilityId\)[\s\S]*?status[\s\S]*?ARCHIVED[\s\S]*?throw new ForbiddenError\(message\);/,
  "controller-side mutation endpoints should share an archived-capability guard",
);

assert.match(
  controller,
  /async uploadKnowledge\(req: Request, res: Response\) \{[\s\S]*?if \(files\.length === 0\) return res\.status\(400\)\.json\(\{ error: "no files" \}\);[\s\S]*?await assertCapabilityMutable\(req\.params\.id, "Capability is archived; knowledge upload is read-only\."\);[\s\S]*?findDuplicateKnowledgeUploadName\(files\)[\s\S]*?extractKnowledgeText\(f\)/,
  "knowledge upload should reject archived capabilities before duplicate checks or file text extraction",
);

assert.match(
  routes,
  /import \{ capabilityService \} from "\.\/capability\.service";[\s\S]*?import \{ ForbiddenError \} from "\.\.\/\.\.\/shared\/errors";[\s\S]*?async function requireMutableCapabilityBeforeUpload\(req: Request[\s\S]*?capabilityService\.get\(req\.params\.id\)[\s\S]*?status[\s\S]*?ARCHIVED[\s\S]*?throw new ForbiddenError\("Capability is archived; knowledge upload is read-only\."\);/,
  "knowledge upload route should check archived state before multer buffers multipart files",
);

assert.match(
  routes,
  /capabilityRoutes\.post\(\s*"\/:id\/knowledge-artifacts\/upload",[\s\S]*?requireMutableCapabilityBeforeUpload,[\s\S]*?knowledgeUpload\.array\("files", 10\),[\s\S]*?capabilityController\.uploadKnowledge/,
  "knowledge upload route should run the archived guard before multer and the controller",
);

assert.match(
  controller,
  /async getWorldModel\(req: Request, res: Response\) \{[\s\S]*?const view = await getWorldModel\(req\.params\.id\);[\s\S]*?return ok\(res, childWorldModels\.length > 0 \? \{ \.\.\.view, childWorldModels \} : view, 200\);/,
  "world-model reads should remain available for archived capability evidence",
);

assert.match(
  controller,
  /async redistillWorldModel\(req: Request, res: Response\) \{[\s\S]*?await assertCapabilityMutable\(req\.params\.id, "Capability is archived; world-model maintenance is read-only\."\);[\s\S]*?distillAndUpsertWorldModel\(req\.params\.id\)/,
  "redistill should reject archived capabilities before writing world-model state",
);

assert.match(
  controller,
  /async checkWorldModelFingerprint\(req: Request, res: Response\) \{[\s\S]*?if \(!fingerprint\) return res\.status\(400\)[\s\S]*?await assertCapabilityMutable\(req\.params\.id, "Capability is archived; world-model maintenance is read-only\."\);[\s\S]*?worldModelDriftService\.recordFingerprint/,
  "fingerprint drift writes should reject archived capabilities after request validation and before mutation",
);

assert.match(
  controller,
  /async probeWorldModelCommand\(req: Request, res: Response\) \{[\s\S]*?if \(cwd && cwd\.length > 200\) return res\.status\(400\)[\s\S]*?await assertCapabilityMutable\(req\.params\.id, "Capability is archived; world-model maintenance is read-only\."\);[\s\S]*?probeCommand\(\{ cmd, cwd \}\)/,
  "probe-command should reject archived capabilities before command execution",
);

assert.match(
  controller,
  /async reportAstIndexBuilt\(req: Request, res: Response\) \{[\s\S]*?const n = typeof body\.astIndexFiles[\s\S]*?await assertCapabilityMutable\(req\.params\.id, "Capability is archived; world-model maintenance is read-only\."\);[\s\S]*?upsertWorldModel\(\{/,
  "AST index callbacks should reject archived capabilities before stamping world-model state",
);

assert.match(
  service,
  /import \{ ForbiddenError, NotFoundError \} from "\.\.\/\.\.\/shared\/errors";[\s\S]*?async function assertWorldModelCapabilityWritable[\s\S]*?SELECT status[\s\S]*?FROM "Capability"[\s\S]*?FOR UPDATE[\s\S]*?throw new NotFoundError\("Capability not found"\)[\s\S]*?throw new ForbiddenError\("Capability is archived; world-model maintenance is read-only\."\)/,
  "world-model service writes should lock and reject archived capabilities inside the write transaction",
);

assert.match(
  service,
  /export async function upsertWorldModel[\s\S]*?const row = await prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?await assertWorldModelCapabilityWritable\(tx, input\.capabilityId\);[\s\S]*?tx\.capabilityWorldModel\.upsert/,
  "upsertWorldModel should guard direct bootstrap, drift, and AST callbacks even when callers bypass controller guards",
);

assert.match(
  service,
  /export async function markWorldModelAutoRefreshed[\s\S]*?await prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?await assertWorldModelCapabilityWritable\(tx, capabilityId\);[\s\S]*?tx\.capabilityWorldModel\.upsert/,
  "world-model auto-refresh markers should also reject archived capabilities inside the write transaction",
);

console.log("capability world-model archive guard contract tests passed");
