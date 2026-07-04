import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeAgentListResponse,
  normalizeAgentProfileCreateResponse,
  normalizeAgentVersionListResponse,
  normalizeCapabilityListResponse,
  normalizeProfileSourcesResponse,
  normalizePromptProfileListResponse,
  normalizeProviderPreviewResponse,
  normalizeSkillListResponse,
} from "./agent-studio-model";

const page = fs.readFileSync(path.join(process.cwd(), "src/app/agents/studio/page.tsx"), "utf8");

assert.deepEqual(
  normalizeCapabilityListResponse({
    items: [
      { capability_id: "cap-1", capability_name: "Payments", capability_type: "DELIVERY", status: "ACTIVE" },
      "bad",
      null,
    ],
  }),
  [{ id: "cap-1", name: "Payments", capabilityType: "DELIVERY", status: "ACTIVE" }],
  "Agent Studio capability lists should accept envelopes and filter malformed rows",
);

assert.deepEqual(
  normalizeAgentListResponse({
    templates: [
      { template_id: "agent-1", templateName: "Developer", capability_id: "cap-1", editable: "true", version: "3" },
      { name: "missing id" },
    ],
  }),
  [{
    id: "agent-1",
    name: "Developer",
    description: undefined,
    roleType: undefined,
    capabilityId: "cap-1",
    baseTemplateId: undefined,
    lockedReason: undefined,
    basePromptProfileId: undefined,
    editable: true,
    status: undefined,
    version: 3,
    createdAt: undefined,
    updatedAt: undefined,
  }],
  "Agent template lists should accept templates envelopes and drop rows without ids",
);

assert.deepEqual(
  normalizeSkillListResponse({ skills: [{ skill_id: "skill-1", skillName: "GitHub", skill_type: "GITHUB" }] }),
  [{ id: "skill-1", name: "GitHub", description: undefined, skillType: "GITHUB" }],
  "Local skill lists should normalize skill id/name aliases",
);

assert.deepEqual(
  normalizePromptProfileListResponse({
    profiles: [{
      profile_id: "profile-1",
      name: "Delivery profile",
      layers: [{ id: "layer-link", priority: "2", is_enabled: false, prompt_layer: { id: "layer-1", layer_type: "SYSTEM" } }],
    }],
  })[0],
  {
    id: "profile-1",
    name: "Delivery profile",
    description: undefined,
    layers: [{
      id: "layer-link",
      priority: 2,
      isEnabled: false,
      promptLayer: {
        id: "layer-1",
        name: undefined,
        layerType: "SYSTEM",
        scopeType: undefined,
        content: undefined,
      },
    }],
  },
  "Prompt profile lists should normalize nested prompt layer aliases",
);

const preview = normalizeProviderPreviewResponse({
  title: "GitHub manifest",
  constraints: { providerLocked: "true" },
  capabilities: [
    { capabilityId: "github.issue.read", permissions: ["read", "invoke", "bad"], constraints: { readOnly: true } },
  ],
});
assert.ok(preview, "provider preview should normalize object responses");
assert.equal(preview.providerLocked, true);
assert.deepEqual(preview.capabilities?.[0]?.permissions, ["read", "invoke"]);
assert.equal(preview.capabilities?.[0]?.readOnly, true);

assert.equal(
  normalizeAgentProfileCreateResponse({ template: { id: "new-agent", name: "New Agent" } })?.id,
  "new-agent",
  "Create profile responses should accept template envelopes",
);
assert.equal(
  normalizeAgentProfileCreateResponse({ profile: { templateId: "profile-agent", name: "Profile Agent" } })?.id,
  "profile-agent",
  "Create profile responses should accept profile envelopes",
);

assert.deepEqual(
  normalizeAgentVersionListResponse({ versions: [{ version: "4", change_summary: "restored" }, { version: 0 }] }),
  [{ id: "version-4", version: 4, changeSummary: "restored", snapshot: undefined, createdBy: undefined, createdAt: undefined }],
  "Version history should normalize version envelopes and synthesize a stable id when needed",
);

assert.deepEqual(
  normalizeProfileSourcesResponse({
    sources: [{ skill_id: "source-1", skill_name: "Runbook", source_type: "url_document", permissions: ["read", "edit"], warnings: [123, "check"] }],
    summary: { externalBindings: "1", readOnlyBindings: 1, liveResolutionRequired: "0", warnings: ["summary warning"] },
  }),
  {
    sources: [{
      bindingId: undefined,
      skillId: "source-1",
      skillName: "Runbook",
      skillType: "SOURCE",
      sourceType: "url_document",
      sourceRef: undefined,
      capabilityId: undefined,
      permissions: ["read", "edit"],
      readOnly: false,
      providerLocked: false,
      liveResolutionRequired: false,
      sourceArtifact: undefined,
      warnings: ["123", "check"],
    }],
    summary: {
      totalBindings: 0,
      externalBindings: 1,
      providerManifestBindings: 0,
      documentBindings: 0,
      readOnlyBindings: 1,
      providerLockedBindings: 0,
      invokableBindings: 0,
      liveResolutionRequired: 0,
      missingSourceRefs: 0,
      knowledgeSources: 0,
      knowledgeArtifacts: 0,
      warnings: ["summary warning"],
    },
  },
  "Profile source governance should normalize source rows and numeric summary fields",
);

assert.match(
  page,
  /const capabilities = useMemo\(\(\) => normalizeCapabilityListResponse\(capabilitiesRaw\), \[capabilitiesRaw\]\);/,
  "Agent Studio page should normalize capability list responses before rendering scope controls",
);
assert.match(
  page,
  /const items = useMemo\(\(\) => normalizeAgentListResponse\(data\), \[data\]\);/,
  "Agent Studio page should normalize template list responses before filtering agent rows",
);
assert.match(
  page,
  /const localSkills = useMemo\(\(\) => normalizeSkillListResponse\(skillsRaw\), \[skillsRaw\]\);[\s\S]*?const promptProfiles = useMemo\(\(\) => normalizePromptProfileListResponse\(profilesRaw\), \[profilesRaw\]\);/,
  "Create Agent wizard should normalize local skill and prompt profile responses",
);
assert.match(
  page,
  /const preview = normalizeProviderPreviewResponse\([\s\S]*?runtimeApi\.previewSkillSource/,
  "Provider manifest previews should be normalized before entering React state",
);
assert.match(
  page,
  /const template = normalizeAgentProfileCreateResponse\(result\);/,
  "Create Agent should normalize template/profile response envelopes before selecting the new agent",
);
assert.doesNotMatch(
  page,
  /runtimeApi\.listCapabilities\(\) as Promise<Capability\[\]>|\(data\?\.items \?\? \[\]\) as Agent\[\]|as ProviderPreview|as Promise<AgentVersion\[\]>/,
  "Agent Studio should not rely on brittle API response casts for core lists and previews",
);

console.log("agent studio normalization contract tests passed");
