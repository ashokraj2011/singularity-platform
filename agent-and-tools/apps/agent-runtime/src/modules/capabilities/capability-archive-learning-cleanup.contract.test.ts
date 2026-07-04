import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");

assert.match(
  service,
  /async archive\(id: string,[\s\S]*?prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?tx\.capabilityRepository\.updateMany\([\s\S]*?pollIntervalSec: null[\s\S]*?tx\.capabilityKnowledgeSource\.updateMany\([\s\S]*?pollIntervalSec: null/,
  "capability archive should disable repository and document polling inside the archive transaction",
);

assert.match(
  service,
  /async archive\(id: string,[\s\S]*?tx\.capabilityLearningWorkerLock\.deleteMany\(\{[\s\S]*?where: \{ capabilityId: id \}[\s\S]*?\}\);[\s\S]*?tx\.capabilityLearningStatus\.upsert\(\{[\s\S]*?status: "ARCHIVED"[\s\S]*?message: learningMessageForStatus\("ARCHIVED"\)[\s\S]*?archiveCancelledLearningWorker: true/,
  "capability archive should cancel active learning-worker leases and stamp grounding status as archived",
);

assert.match(
  service,
  /async function withActiveCapabilityLearningStatusWrite<[\s\S]*?SELECT status[\s\S]*?FROM "Capability"[\s\S]*?WHERE id = \$\{capabilityId\}[\s\S]*?FOR UPDATE[\s\S]*?if \(capability\.status === "ARCHIVED"\) return null;[\s\S]*?return write\(tx\);/,
  "learning status writers should lock the capability row and skip writes once archive has committed",
);

assert.match(
  service,
  /async function recordRepositoryLearningStatus[\s\S]*?withActiveCapabilityLearningStatusWrite\(capabilityId, async \(tx\) => tx\.capabilityLearningStatus\.upsert[\s\S]*?async function recordLearningFailure[\s\S]*?withActiveCapabilityLearningStatusWrite\(capabilityId, async \(tx\) => tx\.capabilityLearningStatus\.upsert/,
  "late learning-worker success or failure writes must not overwrite archived grounding status",
);

assert.match(
  service,
  /tx\.capabilityLearningCandidate\.updateMany\(\{[\s\S]*?where: \{ capabilityId: id, status: "PENDING" \}[\s\S]*?data: \{ status: "REJECTED", reviewedBy: userId, reviewedAt: new Date\(\) \}/,
  "capability archive should reject pending learning candidates so archived capabilities cannot later materialize them",
);

assert.match(
  service,
  /const \[scopedTemplates, scopedBindings\] = await Promise\.all\(\[[\s\S]*?tx\.agentTemplate\.findMany\(\{ where: \{ capabilityId: id \}, select: \{ id: true \} \}\)[\s\S]*?tx\.agentCapabilityBinding\.findMany\(\{ where: \{ capabilityId: id \}, select: \{ id: true \} \}\)/,
  "capability archive should capture owned template and binding ids before archiving them",
);

assert.match(
  service,
  /const toolGrantScopes: Prisma\.ToolGrantWhereInput\[\] = \[[\s\S]*?grantScopeType: "CAPABILITY", grantScopeId: id[\s\S]*?grantScopeType: "AGENT_TEMPLATE", grantScopeId: \{ in: scopedTemplateIds \}[\s\S]*?grantScopeType: "AGENT_BINDING", grantScopeId: \{ in: scopedBindingIds \}/,
  "capability archive should build grant cleanup scopes for capability, owned templates, and owned bindings",
);

assert.match(
  service,
  /tx\.toolGrant\.updateMany\(\{[\s\S]*?where: \{ status: \{ not: "ARCHIVED" \}, OR: toolGrantScopes \}[\s\S]*?data: \{ status: "ARCHIVED" \}/,
  "capability archive should archive active tool grants scoped to the capability, its templates, or its bindings",
);

assert.match(
  service,
  /tx\.toolPolicy\.updateMany\(\{[\s\S]*?where: \{ status: \{ not: "ARCHIVED" \}, OR: toolPolicyScopes \}[\s\S]*?data: \{ status: "ARCHIVED" \}/,
  "capability archive should archive active tool policies scoped to the capability, its templates, or its bindings",
);

assert.match(
  service,
  /async reembedCapability\(capabilityId: string[\s\S]*?await requireActiveCapability\(capabilityId\);/,
  "re-embedding should reject archived capabilities instead of mutating archived runtime context",
);

assert.match(
  service,
  /async reembedCapability\(capabilityId: string[\s\S]*?UPDATE "CapabilityKnowledgeArtifact" target[\s\S]*?target\.status = 'ACTIVE'[\s\S]*?WHERE c\.id = target\."capabilityId"[\s\S]*?c\.status <> 'ARCHIVED'[\s\S]*?UPDATE "DistilledMemory" target[\s\S]*?target\."scopeType" = 'CAPABILITY'[\s\S]*?WHERE c\.id = target\."scopeId"[\s\S]*?c\.status <> 'ARCHIVED'/,
  "re-embedding should skip late knowledge and memory writes once the owning capability is archived",
);

assert.match(
  service,
  /async function ensureCodeSymbolEmbedding[\s\S]*?SELECT c\.status AS "capabilityStatus"[\s\S]*?JOIN "Capability" c ON c\.id = s\."capabilityId"[\s\S]*?if \(!probe\[0\] \|\| probe\[0\]\.capabilityStatus === "ARCHIVED"[\s\S]*?FOR UPDATE OF c[\s\S]*?if \(!activeRows\[0\] \|\| activeRows\[0\]\.capabilityStatus === "ARCHIVED"\) return false;[\s\S]*?UPDATE "CapabilityCodeEmbedding" target[\s\S]*?c\.status <> 'ARCHIVED'/,
  "code embedding writes should be guarded by the owning capability status before and inside the locked write transaction",
);

console.log("capability archive learning cleanup contract tests passed");
