/**
 * Test and offline providers.
 *
 * Every contract test runs against these. NO TEST CALLS A LIVE MODEL: a suite
 * that depends on a network is not a suite you can trust to gate a release, and
 * a model's phrasing is not a thing to assert on.
 */
import { LlmProviderError, type LlmDecisionRequest, type LlmProvider, type LlmRawResponse } from "./types";

/** Replays scripted responses in order. The last one repeats if exhausted. */
export class ScriptedLlmProvider implements LlmProvider {
  readonly name = "scripted";
  readonly model = "scripted-fixture";
  readonly isAvailable = true;

  private callIndex = 0;
  readonly prompts: string[] = [];

  constructor(private readonly responses: readonly (string | null | Error)[]) {
    if (responses.length === 0) {
      throw new Error("ScriptedLlmProvider requires at least one response");
    }
  }

  get callCount(): number {
    return this.callIndex;
  }

  async generateDecision(request: LlmDecisionRequest): Promise<LlmRawResponse> {
    this.prompts.push(request.userPrompt);
    const index = Math.min(this.callIndex, this.responses.length - 1);
    this.callIndex += 1;
    const scripted = this.responses[index]!;

    if (scripted instanceof Error) throw scripted;

    return {
      text: scripted,
      latencyMs: 1,
      inputTokens: Math.ceil(request.userPrompt.length / 4),
      outputTokens: scripted ? Math.ceil(scripted.length / 4) : 0,
      costPaise: 0,
    };
  }
}

/** Always fails. Stands in for an outage, a bad key, or a network partition. */
export class UnavailableLlmProvider implements LlmProvider {
  readonly name = "unavailable";
  readonly model = "none";
  readonly isAvailable = false;

  constructor(private readonly reason = "No LLM provider is configured") {}

  async generateDecision(): Promise<LlmRawResponse> {
    throw new LlmProviderError(this.reason);
  }
}

/** Never resolves within the timeout. Used to exercise the timeout path. */
export class TimeoutLlmProvider implements LlmProvider {
  readonly name = "timeout";
  readonly model = "timeout-fixture";
  readonly isAvailable = true;

  constructor(private readonly timeoutMs = 20) {}

  async generateDecision(): Promise<LlmRawResponse> {
    await new Promise((resolve) => setTimeout(resolve, this.timeoutMs));
    throw new LlmProviderError(`Request timed out after ${this.timeoutMs}ms`);
  }
}
