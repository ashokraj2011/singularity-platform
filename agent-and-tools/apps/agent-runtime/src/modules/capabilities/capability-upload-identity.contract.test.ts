import assert from "node:assert/strict";
import {
  findDuplicateKnowledgeUploadName,
  uploadedKnowledgeFileNameKey,
} from "./capability-upload-identity";

assert.equal(uploadedKnowledgeFileNameKey(" Runbook.DOCX "), "runbook.docx");
assert.equal(uploadedKnowledgeFileNameKey(" "), null);

assert.equal(
  findDuplicateKnowledgeUploadName([
    { originalname: "Design.md" },
    { originalname: " runbook.docx " },
    { originalname: "RUNBOOK.DOCX" },
  ]),
  "RUNBOOK.DOCX",
);

assert.equal(
  findDuplicateKnowledgeUploadName([
    { originalname: "Design.md" },
    { originalname: "Runbook.docx" },
  ]),
  null,
);

console.log("capability upload identity contracts passed");
