import { ModelProvider, ModelRunInput, ModelRunOutput } from "./model-provider.interface";
import { stubProvider } from "./stub.provider";

const providers: Record<string, ModelProvider> = {
  stub: stubProvider,
};

export const modelRuntimeService = {
  register(provider: ModelProvider) {
    providers[provider.name] = provider;
  },

  async run(input: ModelRunInput): Promise<ModelRunOutput> {
    const provider = providers[input.modelProvider] ?? providers.stub;
    return provider.run(input);
  },
};
