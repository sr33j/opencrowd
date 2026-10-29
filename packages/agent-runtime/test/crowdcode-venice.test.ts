import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { decodePaymentSignatureHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { isContextWindowError } from "@opencrowd/protocol";
import { CrowdCodeVeniceProvider, CROWDCODE_VENICE_PAYEE } from "../src/crowdcode-venice.js";
import { PROVIDER_IDS, isProviderId } from "../src/providers.js";

/** The live service's own 402, captured from mainnet (Base upto + exact, the reseller agent as payee). */
const LIVE_402 = readFileSync(new URL("./fixtures/crowdcode-venice-402.txt", import.meta.url), "utf8").trim();
const answer = { choices: [{ message: { role: "assistant", content: "Hello." }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 2 } };
const request = (extra: Record<string, unknown> = {}) => ({ model: "venice-uncensored-1-2", messages: [{ role: "user" as const, content: "hi" }], tools: [], ...extra });

function harness(options: { paid?: (n: number) => Response; first?: () => Response; required?: string } = {}) {
  const calls: { signature?: string; body: any }[] = [];
  let paidCount = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const signature = (init.headers as Record<string, string>)["payment-signature"];
    calls.push({ signature, body: JSON.parse(String(init.body)) });
    if (!signature) return options.first?.() ?? new Response("{}", { status: 402, headers: { "payment-required": options.required ?? LIVE_402 } });
    paidCount++;
    return options.paid?.(paidCount) ?? new Response(JSON.stringify(answer), { status: 200, headers: {
      "content-type": "application/json",
      "payment-response": encodePaymentResponseHeader({ success: true, transaction: `0x${"ab".repeat(32)}`, network: "eip155:8453", payer: "0x0", amount: "1000" } as any) } });
  }) as unknown as typeof fetch;
  const provider = new CrowdCodeVeniceProvider({ fetchImpl, privateKey: generatePrivateKey(), readContract: async () => 0n, waitForReceipt: async () => ({ blockNumber: 1n }) });
  return { provider, calls };
}

describe("Venice through CrowdCode", () => {
  it("is the venice provider, with venice-direct kept beside it", () => {
    expect(PROVIDER_IDS).toEqual(expect.arrayContaining(["venice", "venice-direct"]));
    expect(isProviderId("venice-direct")).toBe(true);
  });

  it("asks for a quote, lets the budget approve it, pays upto to the reseller only, and books what settled", async () => {
    const { provider, calls } = harness();
    const approved: number[] = [];
    const completion = await provider.complete(request({ authorizePayment: async (cents: number) => { approved.push(cents); } }));
    expect(completion.content).toBe("Hello.");
    expect(approved).toEqual([0.1]); // the 1,000-atomic quote, in cents
    expect(completion.usage.costCents).toBe(0.1);
    expect(calls[0].body).toMatchObject({ model: "venice-uncensored-1-2", max_tokens: 4096 });
    const payment = decodePaymentSignatureHeader(calls[1].signature!) as any;
    expect(payment.accepted).toMatchObject({ scheme: "upto", payTo: CROWDCODE_VENICE_PAYEE });
  });

  it("refuses to pay anyone but the pinned reseller", async () => {
    const wrong = Buffer.from(Buffer.from(LIVE_402, "base64").toString().split(CROWDCODE_VENICE_PAYEE).join("0x9999999999999999999999999999999999999999")).toString("base64");
    const { provider, calls } = harness({ required: wrong });
    await expect(provider.complete(request())).rejects.toThrow(/not paying anyone else/);
    expect(calls.filter((c) => c.signature)).toHaveLength(0);
  });

  it("surfaces a context-window refusal before payment as one the runtime recognises", async () => {
    const { provider } = harness({ first: () => Response.json({ error: "context_window_exceeded", code: "context_window_exceeded",
      message: "context window exceeded: the model holds 128000 tokens" }, { status: 400 }) });
    const error = await provider.complete(request()).catch((e) => e);
    expect(isContextWindowError(error)).toBe(true);
  });

  it("re-signs once when the payment itself is refused, and then gives up", async () => {
    const once = harness({ paid: (n) => n === 1 ? new Response("{}", { status: 402 }) : new Response(JSON.stringify(answer), { status: 200 }) });
    expect((await once.provider.complete(request())).content).toBe("Hello.");
    expect(once.calls.filter((c) => c.signature)).toHaveLength(2);
    const always = harness({ paid: () => new Response("{}", { status: 402 }) });
    await expect(always.provider.complete(request())).rejects.toThrow(/HTTP 402/);
  }, 15_000);

  it("never has two payments from the wallet in flight at once", async () => {
    let inFlight = 0, most = 0;
    const { provider } = harness({ paid: () => {
      inFlight++; most = Math.max(most, inFlight);
      return new Response(new ReadableStream({ start(c) { setTimeout(() => { inFlight--; c.enqueue(new TextEncoder().encode(JSON.stringify(answer))); c.close(); }, 30); } }), { status: 200 });
    } });
    await Promise.all([provider.complete(request()), provider.complete(request()), provider.complete(request())]);
    expect(most).toBe(1);
  });
});
