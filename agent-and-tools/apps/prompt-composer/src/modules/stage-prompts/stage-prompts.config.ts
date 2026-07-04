import { boundedIntEnv } from "../../shared/env-bounds";

export function stagePromptMemoryConfig() {
  return {
    topK: boundedIntEnv("STAGE_PROMPT_MEMORY_TOP_K", 5, 0, 50),
    maxChars: boundedIntEnv("STAGE_PROMPT_MEMORY_MAX_CHARS", 500, 80, 5000),
  };
}
