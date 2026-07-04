import assert from "node:assert/strict";
import {
  dedupeProfileSkillBindings,
  findDuplicateUploadedFileName,
  mergeProfileSkillBindings,
  profileBindingSourceRef,
  profileSkillBindingKey,
  uploadedFileNameKey,
  type ProfileSkillBindingLike,
} from "./agent-profile-binding-identity";

assert.equal(uploadedFileNameKey(" Runbook.DOCX "), "runbook.docx");
assert.equal(uploadedFileNameKey(" "), null);
assert.equal(
  findDuplicateUploadedFileName([
    { originalname: "Runbook.docx" },
    { originalname: "Architecture.md" },
    { originalname: " runbook.DOCX " },
  ]),
  "runbook.DOCX",
);
assert.equal(
  findDuplicateUploadedFileName([
    { originalname: "Runbook.docx" },
    { originalname: "Architecture.md" },
  ]),
  null,
);

assert.equal(
  profileBindingSourceRef({ providerManifestUrl: " https://api.example/manifest.json " }),
  "https://api.example/manifest.json",
);
assert.equal(
  profileSkillBindingKey({ sourceType: "URL_DOCUMENT", url: " HTTPS://docs.example/runbook.md " }),
  "source:url_document:https://docs.example/runbook.md",
);
assert.equal(
  profileSkillBindingKey({ sourceType: "local", skillId: " SKILL-1 " }),
  "skill:skill-1",
);
assert.equal(
  profileSkillBindingKey({ sourceType: "local", skillType: " TOOL ", name: " Test Runner " }),
  "local:tool:test runner",
);

const firstBinding: ProfileSkillBindingLike = {
  sourceType: "provider_manifest",
  sourceRef: "https://api.example/manifest.json",
  permissions: ["read"],
  readOnly: true,
  providerLocked: false,
  metadata: { first: true },
};
const secondBinding: ProfileSkillBindingLike = {
  sourceType: "provider_manifest",
  providerManifestUrl: "https://api.example/manifest.json",
  permissions: ["invoke", "edit"],
  readOnly: false,
  providerLocked: true,
  metadata: { second: true },
};
const merged = mergeProfileSkillBindings(firstBinding, secondBinding);
assert.deepEqual(merged.permissions, ["read", "invoke", "edit"]);
assert.equal(merged.readOnly, true);
assert.equal(merged.providerLocked, true);
assert.deepEqual(merged.metadata, { first: true, second: true });

const deduped = dedupeProfileSkillBindings<ProfileSkillBindingLike>([
  {
    sourceType: "url_document",
    url: "https://docs.example/runbook.md",
    permissions: ["read"],
  },
  {
    sourceType: "url_document",
    sourceRef: "https://docs.example/runbook.md",
    permissions: ["invoke"],
    readOnly: true,
  },
  { sourceType: "local", skillId: "skill-1" },
  { sourceType: "local", skillId: "skill-1", isDefault: false },
  { sourceType: "provider_manifest", name: "missing source stays separate" },
  { sourceType: "provider_manifest", name: "missing source stays separate" },
]);
assert.equal(deduped.length, 4);
assert.deepEqual(deduped[0]?.permissions, ["read", "invoke"]);
assert.equal(deduped[0]?.readOnly, true);

console.log("agent profile binding identity contract tests passed");
