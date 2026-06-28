# Singularity Documentation

This directory is the starting point for operating, extending, and explaining the Singularity platform.

## Start Here

- [Platform Handbook](./platform-handbook.md) - detailed architecture, capabilities, components, installation, configuration, runtime flows, operations, and troubleshooting.
- [Platform Handbook HTML](./platform-handbook.html) - browser-friendly standalone version of the handbook.
- [Unified Platform Web](./unified-platform-web.md) - one frontend container, canonical routes, redirects, and bare-metal notes.
- [Plain Docker Deployment](./plain-docker-deployment.md) - run the core platform with `docker build` and `docker run`, without Docker Compose.
- [Deployment Test Matrix](./deployment-test-matrix.md) - clone into a separate folder and smoke-test Compose, plain Docker, bare-metal, and runtime bridge paths.
- [Data Model Overview](./data-model/00-platform-overview.md) - database ownership, service boundaries, and cross-service relationships.
- [Testing Copilot + Anthropic Gateways](./testing-copilot-and-anthropic.md) - fresh-clone setup + test steps for the two LLM execution paths (Anthropic gateway for workbench/agents; Copilot CLI for copilot SDLC workflows).
- [Runtime Discovery](./runtime-discovery.md) - standardized runtime discovery surface.
- [Trace Contract](./trace-contract.md) - trace propagation and event correlation contract.
- [M35 Hybrid Learning ADR](./adr/0001-m35-hybrid-learning.md) - learning-service and Prompt Composer lesson ownership decision.

## Data Model References

- [IAM](./data-model/01-iam.md)
- [Agent Runtime](./data-model/02-agent-runtime.md)
- [Prompt Composer Owned Tables](./data-model/03-prompt-composer-owned.md)
- [Prompt Composer Runtime Reads](./data-model/03-prompt-composer-runtime-read.md)
- [Workgraph](./data-model/04-workgraph.md)
- [Audit Governance](./data-model/05-audit-gov.md)
- [Tool Service](./data-model/06-tool-service.md)
