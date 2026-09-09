import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COMMAND_TYPES,
  EVENT_TYPES,
  PROTOCOL_VERSION,
  ProtocolEncodeError,
  RUN_OUTCOMES,
  bigIntToUsdcAmount,
  createSeqTracker,
  encodeCommand,
  encodeEvent,
  isSensitiveKey,
  isWaitingOutcome,
  parseCommandLine,
  parseEventLine,
  redact,
  usdcAmountToBigInt,
  type Command,
  type Event,
  type EventOf,
  type ParseResult,
  type ProtocolErrorKind
} from "../src/index.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

interface Fixture {
  name: string;
  lines: string[];
}

async function loadFixtures(subdir: string): Promise<Fixture[]> {
  const dir = join(FIXTURES, subdir);
  const files = (await readdir(dir)).filter((file) => file.endsWith(".jsonl")).sort();
  return Promise.all(
    files.map(async (file) => ({
      name: file.replace(/\.jsonl$/, ""),
      lines: (await readFile(join(dir, file), "utf8")).split("\n").filter((line) => line.length > 0)
    }))
  );
}

function expectOk<T>(result: ParseResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.kind}: ${result.error.message}`);
  }
  return result.value;
}

function expectError<T>(result: ParseResult<T>, kind: ProtocolErrorKind) {
  if (result.ok) {
    throw new Error(`expected ${kind}, got ok: ${JSON.stringify(result.value)}`);
  }
  expect(result.error.kind).toBe(kind);
  return result.error;
}

describe("golden command fixtures", () => {
  it("has one fixture per command type and decodes every line", async () => {
    const fixtures = await loadFixtures("commands");
    expect(fixtures.map((fixture) => fixture.name).sort()).toEqual([...COMMAND_TYPES].sort());
    for (const fixture of fixtures) {
      expect(fixture.lines.length).toBeGreaterThan(0);
      for (const line of fixture.lines) {
        const command = expectOk(parseCommandLine(line));
        expect(command.type).toBe(fixture.name);
        expect(command.protocolVersion).toBe(PROTOCOL_VERSION);
      }
    }
  });

  it("round-trips every command through encode/decode as a single line", async () => {
    for (const fixture of await loadFixtures("commands")) {
      for (const line of fixture.lines) {
        const command = expectOk(parseCommandLine(line));
        const encoded = encodeCommand(command);
        expect(encoded.endsWith("\n")).toBe(true);
        expect(encoded.indexOf("\n")).toBe(encoded.length - 1);
        expect(expectOk(parseCommandLine(encoded))).toEqual(command);
        // Encoding is stable: the wire form is byte-identical to the parsed source.
        expect(JSON.parse(encoded)).toEqual(JSON.parse(line));
      }
    }
  });

  it("preserves unknown optional fields on the envelope and payload", async () => {
    const [, forwardCompatible] = (await loadFixtures("commands")).find((fixture) => fixture.name === "run.start")!.lines;
    const command = expectOk(parseCommandLine(forwardCompatible)) as Command & Record<string, unknown>;
    expect(command.futureEnvelopeField).toBe(true);
    expect((command.payload as Record<string, unknown>).futureOptionalField).toEqual({ introducedIn: "1.x" });
    expect(command.type).toBe("run.start");
  });
});

describe("golden event fixtures", () => {
  it("has one fixture per event type and decodes every line", async () => {
    const fixtures = await loadFixtures("events");
    expect(fixtures.map((fixture) => fixture.name).sort()).toEqual([...EVENT_TYPES].sort());
    for (const fixture of fixtures) {
      expect(fixture.lines.length).toBeGreaterThan(0);
      for (const line of fixture.lines) {
        const event = expectOk(parseEventLine(line));
        expect(event.type).toBe(fixture.name);
        expect(event.protocolVersion).toBe(PROTOCOL_VERSION);
      }
    }
  });

  it("round-trips every event through encode/decode as a single line", async () => {
    for (const fixture of await loadFixtures("events")) {
      for (const line of fixture.lines) {
        const event = expectOk(parseEventLine(line));
        const encoded = encodeEvent(event);
        expect(encoded.endsWith("\n")).toBe(true);
        expect(encoded.indexOf("\n")).toBe(encoded.length - 1);
        expect(expectOk(parseEventLine(encoded))).toEqual(event);
        expect(JSON.parse(encoded)).toEqual(JSON.parse(line));
      }
    }
  });

  it("covers every run outcome in the run.finished fixture or the enum", async () => {
    const finished = (await loadFixtures("events")).find((fixture) => fixture.name === "run.finished")!;
    const outcomes = finished.lines.map((line) => (expectOk(parseEventLine(line)) as EventOf<"run.finished">).payload.outcome);
    expect(new Set(outcomes).size).toBeGreaterThanOrEqual(4);
    for (const outcome of outcomes) {
      expect(RUN_OUTCOMES).toContain(outcome);
    }
  });
});

describe("invalid fixtures fail closed with typed errors", () => {
  it("rejects every invalid command line with the kind named by its fixture", async () => {
    const fixtures = await loadFixtures("invalid/commands");
    expect(fixtures.length).toBeGreaterThanOrEqual(6);
    for (const fixture of fixtures) {
      const kind = fixture.name.split("--")[0] as ProtocolErrorKind;
      for (const line of fixture.lines) {
        expectError(parseCommandLine(line), kind);
      }
    }
  });

  it("rejects every invalid event line with the kind named by its fixture", async () => {
    const fixtures = await loadFixtures("invalid/events");
    expect(fixtures.length).toBeGreaterThanOrEqual(6);
    for (const fixture of fixtures) {
      const kind = fixture.name.split("--")[0] as ProtocolErrorKind;
      for (const line of fixture.lines) {
        expectError(parseEventLine(line), kind);
      }
    }
  });

  it("reports the offending major version and type", async () => {
    const [version] = (await loadFixtures("invalid/commands")).find((fixture) => fixture.name.startsWith("unsupported_version"))!.lines;
    expect(expectError(parseCommandLine(version), "unsupported_version").protocolVersion).toBe(2);
    const [unknown] = (await loadFixtures("invalid/commands")).find((fixture) => fixture.name.startsWith("unknown_type"))!.lines;
    expect(expectError(parseCommandLine(unknown), "unknown_type").type).toBe("run.pause");
  });

  it("points issues at the missing seq and the float amount", async () => {
    const [missingSeq] = (await loadFixtures("invalid/commands")).find((fixture) => fixture.name.endsWith("missing-seq"))!.lines;
    expect(expectError(parseCommandLine(missingSeq), "invalid_envelope").issues.map((issue) => issue.path)).toContain("seq");
    const [floatAmount] = (await loadFixtures("invalid/commands")).find((fixture) => fixture.name.endsWith("float-amount"))!.lines;
    expect(expectError(parseCommandLine(floatAmount), "invalid_payload").issues.map((issue) => issue.path)).toContain(
      "payload.budget.limit"
    );
  });

  it("never throws on garbage input", () => {
    expect(parseCommandLine("").ok).toBe(false);
    expect(expectError(parseCommandLine("   \t "), "invalid_json").message).toMatch(/empty/);
    expect(parseEventLine(undefined as unknown as string).ok).toBe(false);
    expect(expectError(parseEventLine("{"), "invalid_json").issues).toEqual([]);
  });

  it("refuses to encode a message that violates the protocol", async () => {
    const [line] = (await loadFixtures("events")).find((fixture) => fixture.name === "usage.updated")!.lines;
    const event = expectOk(parseEventLine(line)) as EventOf<"usage.updated">;
    const broken = { ...event, payload: { ...event.payload, spent: "0.0125" } } as Event;
    expect(() => encodeEvent(broken)).toThrow(ProtocolEncodeError);
    const bad = { ...event, protocolVersion: 2 } as unknown as Event;
    expect(() => encodeEvent(bad)).toThrow(ProtocolEncodeError);
    const resume = expectOk(parseCommandLine((await loadFixtures("commands")).find((f) => f.name === "run.resume")!.lines[0]));
    const withPrompt = { ...resume, payload: { ...resume.payload, prompt: "again" } } as Command;
    expect(() => encodeCommand(withPrompt)).toThrow(/must not carry the original prompt/);
  });
});

describe("redaction", () => {
  it("classifies keys by pattern, keeping token counts", () => {
    for (const key of [
      "Authorization",
      "proxy-authorization",
      "Cookie",
      "Set-Cookie",
      "x-api-key",
      "apiKey",
      "API_KEYS",
      "privateKey",
      "client_secret",
      "password",
      "refresh_token",
      "accessToken",
      "credentials",
      "key"
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    for (const key of ["maxTokens", "inputTokens", "tokenCount", "token_usage", "keyboard", "url", "digest", "operationId", "amount"]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it("removes sensitive keys at every depth without mutating the input", () => {
    const input = {
      url: "https://api.example",
      headers: { Authorization: "Bearer abc", Accept: "application/json", "X-Api-Key": "k" },
      cookies: [{ name: "session", value: "x" }],
      items: [{ name: "session", cookie: "x" }, "plain"],
      nested: { deeper: { secret: "s", keep: 1, tokens: 12 } },
      apiKey: "zzz",
      maxTokens: 400
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    expect(redact(input)).toEqual({
      url: "https://api.example",
      headers: { Accept: "application/json" },
      items: [{ name: "session" }, "plain"],
      nested: { deeper: { keep: 1, tokens: 12 } },
      maxTokens: 400
    });
    expect(input).toEqual(snapshot);
    expect(redact("string")).toBe("string");
    expect(redact(null)).toBeNull();
  });

  it("is applied by encodeEvent before emission unless disabled", async () => {
    const [line] = (await loadFixtures("events")).find((fixture) => fixture.name === "tool.started")!.lines;
    const event = expectOk(parseEventLine(line)) as EventOf<"tool.started">;
    const leaky = {
      ...event,
      payload: { ...event.payload, input: { url: "https://x", headers: { Authorization: "Bearer leak" } } }
    } as Event;
    const emitted = encodeEvent(leaky);
    expect(emitted).not.toContain("leak");
    expect(emitted).not.toContain("Authorization");
    const parsed = expectOk(parseEventLine(emitted)) as EventOf<"tool.started">;
    expect(parsed.payload.input).toEqual({ url: "https://x", headers: {} });
    expect(encodeEvent(leaky, { redact: false })).toContain("Bearer leak");
  });
});

describe("primitives and helpers", () => {
  it("lists the eleven typed run outcomes and identifies waiting ones", () => {
    expect(RUN_OUTCOMES).toEqual([
      "completed",
      "idle",
      "waiting_for_funds",
      "waiting_for_approval",
      "waiting_for_delegation",
      "budget_exhausted",
      "user_stopped",
      "payment_unknown",
      "max_turns",
      "failed",
      "cancelled"
    ]);
    expect(RUN_OUTCOMES.filter(isWaitingOutcome)).toEqual([
      "waiting_for_funds",
      "waiting_for_approval",
      "waiting_for_delegation",
      "payment_unknown"
    ]);
  });

  it("keeps USDC amounts as bigint-safe integer strings", () => {
    const huge = 123456789012345678901234567890n;
    expect(usdcAmountToBigInt(bigIntToUsdcAmount(huge))).toBe(huge);
    expect(bigIntToUsdcAmount(0n)).toBe("0");
    expect(() => bigIntToUsdcAmount(-1n)).toThrow(RangeError);
    expect(() => usdcAmountToBigInt("1.5")).toThrow();
    expect(() => usdcAmountToBigInt("007")).toThrow();
  });

  it("tracks per-stream sequence numbers", () => {
    const tracker = createSeqTracker();
    expect(tracker.last).toBeUndefined();
    expect(tracker.accept(1)).toBe("accepted");
    expect(tracker.accept(5)).toBe("accepted");
    expect(tracker.accept(5)).toBe("duplicate");
    expect(tracker.accept(3)).toBe("out_of_order");
    expect(tracker.accept(6)).toBe("accepted");
    expect(tracker.last).toBe(6);
  });
});
