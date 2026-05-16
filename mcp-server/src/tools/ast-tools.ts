import type { ToolHandler } from "./registry";
import {
  findSymbols, getAstSlice, getDependencies, getSymbol, indexWorkspace,
  statsForIndex,
} from "../workspace/ast-index";
import {
  branchNameForWork, finishWorkBranch, prepareWorkBranch,
} from "../workspace/git-workspace";

export const indexWorkspaceTool: ToolHandler = {
  descriptor: {
    name: "index_workspace",
    description: "Build or refresh the local AST index for the MCP sandbox.",
    natural_language:
      "Use this before code navigation or after large workspace changes. It stores local symbol/import/slice metadata without sending full files to the model.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why the index is being refreshed" },
      },
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    const stats = await indexWorkspace(typeof args.reason === "string" ? args.reason : "tool");
    return { success: stats.status === "READY", output: stats, error: stats.error };
  },
};

export const findSymbolTool: ToolHandler = {
  descriptor: {
    name: "find_symbol",
    description: "Search the local AST symbol index by name, file, summary, or kind.",
    natural_language:
      "Use this before reading files. It returns compact symbol metadata so you can request exact slices instead of full files.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: { type: "string", description: "Optional kind: function, class, method, interface, type, enum, const" },
        filePath: { type: "string", description: "Optional file path filter" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    const query = String(args.query ?? "");
    if (!query) return { success: false, output: null, error: "query is required" };
    const hits = await findSymbols({
      query,
      kind: typeof args.kind === "string" ? args.kind : undefined,
      filePath: typeof args.filePath === "string" ? args.filePath : undefined,
      limit: typeof args.limit === "number" ? args.limit : undefined,
    });
    return { success: true, output: { query, count: hits.length, hits } };
  },
};

export const getSymbolTool: ToolHandler = {
  descriptor: {
    name: "get_symbol",
    description: "Fetch one local AST symbol's compact metadata.",
    natural_language:
      "Use this when you know a symbol id or name and need its signature, summary, file path, and line range.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
      },
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    const symbol = await getSymbol({
      id: typeof args.id === "string" ? args.id : undefined,
      name: typeof args.name === "string" ? args.name : undefined,
    });
    if (!symbol) return { success: false, output: null, error: "symbol not found" };
    return { success: true, output: { symbol } };
  },
};

export const getAstSliceTool: ToolHandler = {
  descriptor: {
    name: "get_ast_slice",
    description: "Return the exact source slice for a symbol id/name or explicit file line range.",
    natural_language:
      "Use this only after find_symbol/get_symbol, when the compact summary is not enough and you need the exact implementation.",
    input_schema: {
      type: "object",
      properties: {
        symbolId: { type: "string" },
        name: { type: "string" },
        filePath: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" },
        maxBytes: { type: "number" },
      },
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    const slice = await getAstSlice({
      symbolId: typeof args.symbolId === "string" ? args.symbolId : undefined,
      name: typeof args.name === "string" ? args.name : undefined,
      filePath: typeof args.filePath === "string" ? args.filePath : undefined,
      startLine: typeof args.startLine === "number" ? args.startLine : undefined,
      endLine: typeof args.endLine === "number" ? args.endLine : undefined,
      maxBytes: typeof args.maxBytes === "number" ? args.maxBytes : undefined,
    });
    if (!slice) return { success: false, output: null, error: "slice not found" };
    return { success: true, output: slice };
  },
};

export const getDependenciesTool: ToolHandler = {
  descriptor: {
    name: "get_dependencies",
    description: "Return imports/exports captured for a local indexed file.",
    natural_language:
      "Use this to understand dependencies around a symbol before reading larger source slices.",
    input_schema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
      },
      required: ["filePath"],
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    const filePath = String(args.filePath ?? "");
    if (!filePath) return { success: false, output: null, error: "filePath is required" };
    const dependencies = await getDependencies(filePath);
    return { success: true, output: { filePath, count: dependencies.length, dependencies } };
  },
};

export const prepareWorkBranchTool: ToolHandler = {
  descriptor: {
    name: "prepare_work_branch",
    description: "Create or checkout the local branch for a workflow work item.",
    natural_language:
      "Use at the start of a workflow work item before making code changes. The invoke path usually does this automatically.",
    input_schema: {
      type: "object",
      properties: {
        workflowInstanceId: { type: "string" },
        nodeId: { type: "string" },
        workItemId: { type: "string" },
        workItemCode: { type: "string" },
        branchBase: { type: "string" },
        branchName: { type: "string" },
      },
    },
    risk_level: "MEDIUM",
    requires_approval: false,
  },
  async execute(args) {
    const request = {
      workflowInstanceId: typeof args.workflowInstanceId === "string" ? args.workflowInstanceId : undefined,
      nodeId: typeof args.nodeId === "string" ? args.nodeId : undefined,
      workItemId: typeof args.workItemId === "string" ? args.workItemId : undefined,
      workItemCode: typeof args.workItemCode === "string" ? args.workItemCode : undefined,
      branchBase: typeof args.branchBase === "string" ? args.branchBase : undefined,
      branchName: typeof args.branchName === "string" ? args.branchName : undefined,
    };
    if (!branchNameForWork(request)) return { success: false, output: null, error: "branchName or workflowInstanceId+nodeId+workItemId required" };
    const branch = await prepareWorkBranch(request);
    const stats = await indexWorkspace("branch");
    return { success: true, output: { branch, astIndex: stats } };
  },
};

export const finishWorkBranchTool: ToolHandler = {
  descriptor: {
    name: "finish_work_branch",
    description: "Re-index dirty files and commit local workflow changes on the active branch. Set `push: true` to also push the branch to the configured remote.",
    natural_language:
      "Use when workflow work is complete. It commits locally and, when `push: true`, pushes the branch upstream. Returns branch, commit SHA, changed paths, patch summary, and push status.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string" },
        push:    { type: "boolean", description: "When true, push the branch to the named remote after commit (default: false, local-only)." },
        remote:  { type: "string",  description: "Remote name to push to (default: 'origin'). Only used when push=true." },
      },
    },
    // M27.5 — pushing changes upstream is destructive vs the developer's
    // remote so we mark this MCP-level call HIGH risk + approval-required
    // when `push: true`. We keep the no-push path MEDIUM/no-approval to
    // preserve the unchanged local-only behavior.
    risk_level: "MEDIUM",
    requires_approval: false,
  },
  async execute(args) {
    const before = await statsForIndex();
    const push = args.push === true;
    const remote = typeof args.remote === "string" ? args.remote : undefined;
    const result = await finishWorkBranch(
      typeof args.message === "string" ? args.message : undefined,
      { push, remote },
    );
    const after = await indexWorkspace("finish");
    return {
      success: !push || !result.pushError,
      output: {
        kind: result.committed ? "code_change" : "workspace_finish",
        paths_touched: result.changedPaths,
        commit_sha: result.commitSha,
        patch: result.patch,
        branch: result.branch,
        committed: result.committed,
        message: result.message,
        pushed: result.pushed,
        push_error: result.pushError,
        remote: push ? (remote ?? "origin") : undefined,
        astIndexBefore: before,
        astIndexAfter: after,
      },
      error: result.pushError,
    };
  },
};
