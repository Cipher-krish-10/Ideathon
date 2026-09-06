import { describe, expect, it, vi } from "vitest";

import { GroqProvider, LlmProviderError } from "@/integrations/llm";

/**
 * Groq adapter tests. `fetch` is injected, so nothing here touches the network
 * and no API key is required to run the suite.
 */

const OK_BODY = {
  choices: [{ message: { content: '{"selectedPlaybookId":"pb-1"}' }, finish_reason: "stop" }],
  usage: { prompt_tokens: 120, completion_tokens: 45 },
};

function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: init.status ?? (init.ok === false ? 500 : 200),
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

const request = { systemPrompt: "system rules", userPrompt: "candidate table" };

describe("GroqProvider", () => {
  it("requires an API key", () => {
    expect(() => new GroqProvider({ apiKey: "" })).toThrow(LlmProviderError);
  });

  it("posts an OpenAI-compatible chat completion and parses the reply", async () => {
    const fetchImpl = stubFetch(OK_BODY);
    const provider = new GroqProvider({ apiKey: "gsk_test", fetchImpl });

    const result = await provider.generateDecision(request);

    expect(result.text).toBe('{"selectedPlaybookId":"pb-1"}');
    expect(result.inputTokens).toBe(120);
    expect(result.outputTokens).toBe(45);
    expect(result.stopReason).toBe("stop");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");

    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body.model).toBe("openai/gpt-oss-120b");
    // Zero temperature: a demo must not produce a different recommendation on
    // a re-run over the same candidate table.
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toEqual([
      { role: "system", content: "system rules" },
      { role: "user", content: "candidate table" },
    ]);
  });

  it("sends the key as a bearer token and nowhere else", async () => {
    const fetchImpl = stubFetch(OK_BODY);
    await new GroqProvider({ apiKey: "gsk_secret", fetchImpl }).generateDecision(request);

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer gsk_secret");
    // The credential must never reach the prompt body.
    expect((init as RequestInit).body as string).not.toContain("gsk_secret");
  });

  it("honours a configured model id", async () => {
    const fetchImpl = stubFetch(OK_BODY);
    await new GroqProvider({
      apiKey: "gsk_test", model: "qwen/qwen3.8-27b", fetchImpl,
    }).generateDecision(request);

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body.model).toBe("qwen/qwen3.8-27b");
  });

  it("surfaces a provider error message, so a bad key or model id is legible", async () => {
    const fetchImpl = stubFetch(
      { error: { message: "The model `nope` does not exist" } },
      { status: 404 },
    );
    const provider = new GroqProvider({ apiKey: "gsk_test", model: "nope", fetchImpl });

    await expect(provider.generateDecision(request)).rejects.toThrow(
      /Groq returned 404: The model `nope` does not exist/,
    );
  });

  it("throws a typed error on an auth failure", async () => {
    const fetchImpl = stubFetch({ error: { message: "Invalid API Key" } }, { status: 401 });
    const provider = new GroqProvider({ apiKey: "gsk_bad", fetchImpl });
    await expect(provider.generateDecision(request)).rejects.toBeInstanceOf(LlmProviderError);
  });

  it("returns null text for an empty completion rather than an empty string", async () => {
    // The reasoner treats null as EMPTY_RESPONSE and falls back; an empty
    // string would be indistinguishable from unset further down.
    const fetchImpl = stubFetch({ choices: [{ message: { content: "   " } }] });
    const result = await new GroqProvider({ apiKey: "gsk_test", fetchImpl }).generateDecision(request);
    expect(result.text).toBeNull();
  });

  it("reports a timeout as a provider error", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
      const signal = (init as RequestInit).signal!;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }) as unknown as typeof fetch;

    const provider = new GroqProvider({ apiKey: "gsk_test", timeoutMs: 10, fetchImpl });
    await expect(provider.generateDecision(request)).rejects.toThrow(/timed out/);
  });

  it("omits costPaise rather than recording a fabricated figure", async () => {
    const result = await new GroqProvider({
      apiKey: "gsk_test", fetchImpl: stubFetch(OK_BODY),
    }).generateDecision(request);
    expect(result.costPaise).toBeUndefined();
  });

  it("wraps a network failure so the reasoner falls back instead of crashing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(
      new GroqProvider({ apiKey: "gsk_test", fetchImpl }).generateDecision(request),
    ).rejects.toThrow(/Groq request failed/);
  });
});
