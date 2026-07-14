import assert from "node:assert/strict";
import { diffToOps, remapCaret } from "./coeditDiff";

// diffToOps — single-region prefix/suffix diff
assert.deepEqual(diffToOps("hello", "hello world"), { index: 5, delete: 0, insert: " world" }, "append");
assert.deepEqual(diffToOps("hello world", "hello"), { index: 5, delete: 6, insert: "" }, "truncate");
assert.deepEqual(diffToOps("the cat sat", "the dog sat"), { index: 4, delete: 3, insert: "dog" }, "replace middle");
assert.deepEqual(diffToOps("bar", "foobar"), { index: 0, delete: 0, insert: "foo" }, "prefix insert");
assert.equal(diffToOps("same", "same"), null, "no change → null");

// remapCaret — remote edits shift the local caret correctly
assert.equal(remapCaret([{ insert: "xy" }], 3), 5, "insert before caret pushes it right");
assert.equal(remapCaret([{ retain: 5 }, { insert: "xy" }], 3), 3, "insert after caret leaves it");
assert.equal(remapCaret([{ delete: 2 }], 5), 3, "delete before caret pulls it left");
assert.equal(remapCaret([{ retain: 10 }, { delete: 2 }], 3), 3, "delete after caret leaves it");

console.log("coedit-diff.contract.test.ts passed");
