import type { z } from "zod";
import { PROTOCOL_VERSION } from "./version.js";
import { COMMAND_TYPES, CommandSchema, type Command } from "./commands.js";
import { EVENT_TYPES, EventSchema, type Event } from "./events.js";
import { redact } from "./redact.js";

export type ProtocolErrorKind =
  /** The line is empty or not valid JSON. */
  | "invalid_json"
  /** JSON, but not an object, or the envelope fields are wrong (missing `seq`, bad `id`, ...). */
  | "invalid_envelope"
  /** `protocolVersion` is a major this decoder does not speak. Fail closed. */
  | "unsupported_version"
  /** `type` is not a known command/event type for this major. */
  | "unknown_type"
  /** The envelope is fine but `payload` does not match the schema for `type`. */
  | "invalid_payload";

export interface ProtocolIssue {
  /** Dot-joined path into the message, e.g. `payload.budget.limit`. */
  path: string;
  message: string;
}

export interface ProtocolError {
  kind: ProtocolErrorKind;
  message: string;
  issues: ProtocolIssue[];
  /** Populated for `unsupported_version`. */
  protocolVersion?: number;
  /** Populated for `unknown_type`. */
  type?: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: ProtocolError };

function fail(error: ProtocolError): ParseResult<never> {
  return { ok: false, error };
}

function formatIssues(error: z.ZodError): ProtocolIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));
}

function parseLine<T>(line: string, schema: z.ZodType<T>, knownTypes: readonly string[], label: string): ParseResult<T> {
  const trimmed = typeof line === "string" ? line.trim() : "";
  if (trimmed.length === 0) {
    return fail({ kind: "invalid_json", message: `empty ${label} line`, issues: [] });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail({ kind: "invalid_json", message: `${label} line is not valid JSON: ${message}`, issues: [] });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fail({ kind: "invalid_envelope", message: `${label} must be a JSON object`, issues: [] });
  }
  const envelope = raw as Record<string, unknown>;
  const version = envelope.protocolVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return fail({
      kind: "invalid_envelope",
      message: `${label} is missing an integer protocolVersion`,
      issues: [{ path: "protocolVersion", message: "expected an integer" }]
    });
  }
  if (version !== PROTOCOL_VERSION) {
    return fail({
      kind: "unsupported_version",
      message: `unsupported protocol version ${version}; this decoder speaks version ${PROTOCOL_VERSION}`,
      issues: [],
      protocolVersion: version
    });
  }
  const type = envelope.type;
  if (typeof type !== "string") {
    return fail({
      kind: "invalid_envelope",
      message: `${label} is missing a string type`,
      issues: [{ path: "type", message: "expected a string" }]
    });
  }
  if (!knownTypes.includes(type)) {
    return fail({ kind: "unknown_type", message: `unknown ${label} type "${type}"`, issues: [], type });
  }
  const result = schema.safeParse(envelope);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  const issues = formatIssues(result.error);
  const inPayload = issues.length > 0 && issues.every((issue) => issue.path === "payload" || issue.path.startsWith("payload."));
  return fail({
    kind: inPayload ? "invalid_payload" : "invalid_envelope",
    message: `${label} "${type}" failed validation: ${issues.map((issue) => `${issue.path || "$"}: ${issue.message}`).join("; ")}`,
    issues
  });
}

/** Decodes one JSONL command line. Never throws. */
export function parseCommandLine(line: string): ParseResult<Command> {
  return parseLine(line, CommandSchema, COMMAND_TYPES, "command");
}

/** Decodes one JSONL event line. Never throws. */
export function parseEventLine(line: string): ParseResult<Event> {
  return parseLine(line, EventSchema, EVENT_TYPES, "event");
}

/** Thrown by the encoders when handed a message that violates the protocol. */
export class ProtocolEncodeError extends Error {
  readonly issues: ProtocolIssue[];

  constructor(label: string, issues: ProtocolIssue[]) {
    super(`refusing to encode invalid ${label}: ${issues.map((issue) => `${issue.path || "$"}: ${issue.message}`).join("; ")}`);
    this.name = "ProtocolEncodeError";
    this.issues = issues;
  }
}

function encodeLine<T>(value: T, schema: z.ZodType<T>, label: string): string {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ProtocolEncodeError(label, formatIssues(result.error));
  }
  // JSON.stringify escapes \n and \r inside strings, so the output is exactly one line.
  return `${JSON.stringify(result.data)}\n`;
}

/** Encodes a command as a single JSONL line with a trailing newline. */
export function encodeCommand(command: Command): string {
  return encodeLine(command, CommandSchema, "command");
}

export interface EncodeEventOptions {
  /** Strip sensitive keys from the payload first. Defaults to true. */
  redact?: boolean;
}

/**
 * Encodes an event as a single JSONL line with a trailing newline. The
 * payload is redacted before validation so a redacted event is still valid.
 */
export function encodeEvent(event: Event, options: EncodeEventOptions = {}): string {
  const prepared = options.redact === false ? event : { ...event, payload: redact(event.payload) };
  return encodeLine(prepared as Event, EventSchema, "event");
}
