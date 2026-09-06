import "server-only";

import {
  LlmProviderError,
  type LlmDecisionRequest,
  type LlmProvider,
  type LlmRawResponse,
} from "./types";

/**
 * Groq-backed provider.
 *
 * Groq serves open models behind an OpenAI-compatible chat-completions API, so
 * this is a plain fetch against one endpoint rather than another SDK. Keeping it
 * dependency-free is deliberate: the vendor detail belongs in this file and
 * nowhere else, exactly as with the Anthropic adapter.
 *
 * Like that adapter, this module is the ONLY holder of its credential. The key
 * is read here, never logged, and never placed in a prompt or an LlmCall row.
 */
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

/**
 * Default model. Groq's catalogue changes, so this is configurable via
 * GROQ_MODEL — confirm the id against Groq's current model list if a call
 * returns a model-not-found error.
 */
const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_MAX_TOKENS = 2_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Minimal shape of the response we depend on. */
interface GroqChatResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
}

export interface GroqProviderOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Injectable for tests, so no test ever reaches the network. */
  fetchImpl?: typeof fetch;
}

export class GroqProvider implements LlmProvider {
  readonly name = "groq";
  readonly model: string;
  readonly isAvailable = true;

  private readonly apiKey: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GroqProviderOptions) {
    if (!options.apiKey) {
      throw new LlmProviderError("GroqProvider requires an API key");
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generateDecision(request: LlmDecisionRequest): Promise<LlmRawResponse> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? this.timeoutMs);

    try {
      const response = await this.fetchImpl(GROQ_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: request.maxTokens ?? this.maxTokens,
          // Zero temperature: the same candidate table should not produce a
          // different recommendation on a re-run during a demo.
          temperature: request.temperature ?? 0,
          // The reasoner expects one JSON object. Constraining the format here
          // removes the most common cause of a MALFORMED_JSON rejection.
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: request.systemPrompt },
            { role: "user", content: request.userPrompt },
          ],
        }),
        signal: controller.signal,
      });

      const body = (await response.json().catch(() => ({}))) as GroqChatResponse;

      if (!response.ok) {
        // Surface the provider's own message; it names bad keys and unknown
        // model ids precisely, which is what the operator needs to see.
        throw new LlmProviderError(
          `Groq returned ${response.status}: ${body.error?.message ?? response.statusText}`,
        );
      }

      const text = body.choices?.[0]?.message?.content?.trim() ?? "";

      return {
        text: text.length > 0 ? text : null,
        latencyMs: Date.now() - startedAt,
        ...(body.usage?.prompt_tokens === undefined
          ? {}
          : { inputTokens: body.usage.prompt_tokens }),
        ...(body.usage?.completion_tokens === undefined
          ? {}
          : { outputTokens: body.usage.completion_tokens }),
        ...(body.choices?.[0]?.finish_reason === undefined
          ? {}
          : { stopReason: body.choices[0].finish_reason }),
        // costPaise is deliberately omitted: Groq's per-model pricing is not
        // encoded here, and a fabricated cost is worse than a missing one.
      };
    } catch (error) {
      if (error instanceof LlmProviderError) throw error;
      const elapsed = Date.now() - startedAt;
      if ((error as Error).name === "AbortError") {
        throw new LlmProviderError(`Groq request timed out after ${elapsed}ms`, error);
      }
      throw new LlmProviderError(
        `Groq request failed after ${elapsed}ms: ${(error as Error).message}`,
        error,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
