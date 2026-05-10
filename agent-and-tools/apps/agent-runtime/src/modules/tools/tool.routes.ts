import { Router } from "express";
import { toolController } from "./tool.controller";
import { validate } from "../../middleware/validate.middleware";
import {
  registerToolSchema, createContractSchema, createPolicySchema,
  grantSchema, validateCallSchema,
} from "./tool.schemas";

export const toolRoutes = Router();

toolRoutes.post("/", validate(registerToolSchema), toolController.register);
toolRoutes.get("/", toolController.list);

// Order matters: more specific paths first
toolRoutes.post("/policies", validate(createPolicySchema), toolController.createPolicy);
toolRoutes.get("/policies", toolController.listPolicies);

toolRoutes.post("/grants", validate(grantSchema), toolController.createGrant);
toolRoutes.get("/grants", toolController.listGrants);

toolRoutes.post("/validate-call", validate(validateCallSchema), toolController.validateCall);

toolRoutes.get("/:id", toolController.get);
toolRoutes.post("/:id/contracts", validate(createContractSchema), toolController.createContract);
