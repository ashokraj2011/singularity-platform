import { v4 as uuidv4 } from "uuid";
import { ModelProvider, ModelRunInput, ModelRunOutput } from "./model-provider.interface";

/**
 * Deterministic stub provider used until real OpenAI/OpenRouter providers are wired.
 * Inspects the prompt for `<TOOL_CALL>name|json</TOOL_CALL>` markers and returns those
 * as toolCalls. Otherwise returns a canned analysis text.
 */
export const stubProvider: ModelProvider = {
  name: "stub",
  async run(input: ModelRunInput): Promise<ModelRunOutput> {
    const last = input.messages[input.messages.length - 1]?.content ?? "";
    const matches = [...last.matchAll(/<TOOL_CALL>([^|]+)\|([^<]+)<\/TOOL_CALL>/g)];
    if (matches.length > 0) {
      return {
        toolCalls: matches.map(m => {
          let parsed: unknown = {};
          try { parsed = JSON.parse(m[2]); } catch { parsed = { raw: m[2] }; }
          return { id: uuidv4(), name: m[1].trim(), input: parsed };
        }),
        usage: { inputTokens: input.messages.reduce((n, m) => n + m.content.length / 4, 0) | 0, outputTokens: 0 },
      };
    }

    return {
      text:
        "## Summary\n" +
        "Stub model response. Replace `stub` with `openai` or `openrouter` and provide an API key " +
        "to get real analysis.\n\n" +
        "## Evidence Used\n" +
        "(none — stub provider)\n",
      usage: { inputTokens: input.messages.reduce((n, m) => n + m.content.length / 4, 0) | 0, outputTokens: 50 },
    };
  },
};
