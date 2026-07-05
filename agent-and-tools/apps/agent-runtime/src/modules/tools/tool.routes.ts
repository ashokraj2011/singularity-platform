import { Router } from "express";
import { toolController } from "./tool.controller";
import { validate } from "../../middleware/validate.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import {
  registerToolSchema, createContractSchema, createPolicySchema,
  grantSchema, updateGrantSchema, updatePolicySchema, validateCallSchema,
} from "./tool.schemas";

export const toolRoutes = Router();

toolRoutes.use(requireAuth);

toolRoutes.post("/", validate(registerToolSchema), toolController.register);
toolRoutes.get("/", toolController.list);

// Order matters: more specific paths first
toolRoutes.post("/policies", validate(createPolicySchema), toolController.createPolicy);
toolRoutes.get("/policies", toolController.listPolicies);
toolRoutes.patch("/policies/:id", validate(updatePolicySchema), toolController.updatePolicy);
toolRoutes.delete("/policies/:id", toolController.deletePolicy);

toolRoutes.post("/grants", validate(grantSchema), toolController.createGrant);
toolRoutes.get("/grants", toolController.listGrants);
toolRoutes.patch("/grants/:id", validate(updateGrantSchema), toolController.updateGrant);
toolRoutes.delete("/grants/:id", toolController.deleteGrant);

toolRoutes.post("/validate-call", validate(validateCallSchema), toolController.validateCall);

toolRoutes.get("/:id", toolController.get);
toolRoutes.post("/:id/contracts", validate(createContractSchema), toolController.createContract);
