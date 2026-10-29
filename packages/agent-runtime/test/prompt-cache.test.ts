import { expect, it } from "vitest";
import { BlockRunProvider } from "../src/blockrun.js";
import { X402ProxyProvider } from "../src/x402-proxy.js";
import { normalizeUsage } from "../src/providers.js";

it.each(["blockrun", "x402"])("%s sends Claude cache opt-in and a stable conversation key", async adapter => {
  const bodies: Record<string, unknown>[] = [];
  const completion = { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] };
  const provider = adapter === "blockrun" ? new BlockRunProvider({ clientFactory: async () => ({
    getSpending: () => ({ totalUsd: 0, calls: 0 }),
    async *stream(_path, body) { bodies.push(body!); yield completion as never; },
  }) }) : new X402ProxyProvider({ baseUrl: "https://proxy.test/v1", fetchImpl: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json(completion);
  } });
  for (const content of ["first", "second"]) await provider.complete({
    model: "anthropic/claude-sonnet-4.6", messages: [{ role: "user", content }], tools: [], promptCacheKey: "conversation-1",
  });
  expect(bodies).toHaveLength(2);
  for (const body of bodies) expect(body).toMatchObject({ prompt_cache: true, prompt_cache_key: "conversation-1" });
});

it("normalizes BlockRun cache creation and native Claude read counters", () => {
  expect(normalizeUsage({ prompt_tokens: 4096, prompt_tokens_details: { cached_tokens: 3072, cached_creation_tokens: 1024 } }))
    .toMatchObject({ inputTokens: 4096, cachedInputTokens: 3072, cacheWriteTokens: 1024 });
  expect(normalizeUsage({ cache_read_input_tokens: 3072, cache_creation_input_tokens: 1024 }))
    .toMatchObject({ cachedInputTokens: 3072, cacheWriteTokens: 1024 });
  expect(normalizeUsage({})).toMatchObject({ cachedInputTokens: undefined, cacheWriteTokens: undefined });
});
