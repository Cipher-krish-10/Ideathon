import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { LlmProviderError, type LlmDecisionRequest, type LlmProvider, type LlmRawResponse } from "./types";

/**
 * Anthropic-backed provider.
 *
 * The ONLY module that holds the API credential. It is read here and nowhere
 * else, and never appears in a prompt, a log line, or an LlmCall row.
 */
const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_MAX_TOKENS = 2_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Published per-million-token pricing, in paise, used only to record an
 * approximate spend on each call. Wrong pricing produces a wrong cost estimate,
 * never a wrong financial decision — no estimate or guardrail reads this.
 */
const PRICE_PAISE_PER_MTOK_INPUT = 25_000;
const PRICE_PAISE_PER_MTOK_OUTPUT = 125_000;

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly model: string;
  readonly isAvailable = true;

  private readonly client: Anthropic;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(options: AnthropicProviderOptions) {
    if (!options.apiKey) {
      throw new LlmProviderError("AnthropicProvider requires an API key");
    }
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.client = new Anthropic({ apiKey: options.apiKey, timeout: this.timeoutMs });
  }

  async generateDecision(request: LlmDecisionRequest): Promise<LlmRawResponse> {
    const startedAt = Date.now();
    try {
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: request.maxTokens ?? this.maxTokens,
          temperature: request.temperature ?? 0,
          system: request.systemPrompt,
          messages: [{ role: "user", content: request.userPrompt }],
        },
        { timeout: request.timeoutMs ?? this.timeoutMs },
      );

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();

      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;

      return {
        text: text.length > 0 ? text : null,
        latencyMs: Date.now() - startedAt,
        inputTokens,
        outputTokens,
        stopReason: response.stop_reason ?? undefined,
        costPaise: Math.round(
          (inputTokens * PRICE_PAISE_PER_MTOK_INPUT +
            outputTokens * PRICE_PAISE_PER_MTOK_OUTPUT) /
            1_000_000,
        ),
      };
    } catch (error) {
      // Surface as a typed provider error so the reasoner treats it as an
      // operating condition and falls back, rather than crashing the request.
      throw new LlmProviderError(
        `Anthropic request failed after ${Date.now() - startedAt}ms: ${(error as Error).message}`,
        error,
      );
    }
  }
}
