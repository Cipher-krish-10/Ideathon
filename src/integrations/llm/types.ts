/**
 * Provider boundary for the reasoning model.
 *
 * An anti-corruption layer, exactly like the Razorpay adapter will be: nothing
 * outside this directory knows which vendor SDK is in use, and src/core knows
 * only that it was handed a function returning text.
 */
export interface LlmDecisionRequest {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface LlmRawResponse {
  text: string | null;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
  /** Estimated spend in integer paise, when the provider's pricing is known. */
  costPaise?: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** True when the provider is configured and usable. */
  readonly isAvailable: boolean;
  generateDecision(request: LlmDecisionRequest): Promise<LlmRawResponse>;
}

export class LlmProviderError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LlmProviderError";
  }
}
