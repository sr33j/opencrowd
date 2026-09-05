import { z } from "zod";
import { PROTOCOL_VERSION } from "./version.js";
import { IdSchema, JsonValueSchema, SeqSchema, TimestampSchema, UsdcAmountSchema } from "./primitives.js";
import { RunOutcomeSchema, RunStateSchema } from "./outcomes.js";
import { CommandTypeSchema } from "./commands.js";

/**
 * Events flow worker -> supervisor on stdout, one JSON object per line.
 * `commandId` links an event to the command that caused it; `runId` scopes it
 * to a run. Both are required only where the event cannot exist without them.
 */
const eventBase = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  id: IdSchema,
  seq: SeqSchema,
  emittedAt: TimestampSchema
};

const runScoped = {
  ...eventBase,
  commandId: IdSchema.optional(),
  runId: IdSchema
};

const turnField = { turn: z.int().nonnegative().optional() };

export const WorkerReadyEventSchema = z.looseObject({
  ...eventBase,
  type: z.literal("worker.ready"),
  payload: z.looseObject({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    runtimeVersion: z.string().min(1),
    workerId: IdSchema.optional(),
    /** Set when the worker restored an unfinished run after a restart. */
    restoredRunId: IdSchema.optional()
  })
});

export const CommandAcceptedEventSchema = z.looseObject({
  ...eventBase,
  type: z.literal("command.accepted"),
  commandId: IdSchema,
  runId: IdSchema.optional(),
  payload: z.looseObject({
    commandType: CommandTypeSchema,
    /** True when the command ID was already processed and this is an idempotent re-acknowledgement. */
    duplicate: z.boolean()
  })
});

export const CommandRejectionReasonSchema = z.enum([
  "invalid_command",
  "unsupported_version",
  "run_active",
  "unknown_run",
  "run_not_resumable",
  "conflicting_duplicate",
  "shutting_down"
]);
export type CommandRejectionReason = z.infer<typeof CommandRejectionReasonSchema>;

export const CommandRejectedEventSchema = z.looseObject({
  ...eventBase,
  type: z.literal("command.rejected"),
  /** Absent when the line could not be decoded far enough to read an ID. */
  commandId: IdSchema.optional(),
  runId: IdSchema.optional(),
  payload: z.looseObject({
    commandType: CommandTypeSchema.optional(),
    reason: CommandRejectionReasonSchema,
    message: z.string(),
    issues: z.array(z.looseObject({ path: z.string(), message: z.string() })).optional()
  })
});

export const RunStateEventSchema = z.looseObject({
  ...runScoped,
  type: z.literal("run.state"),
  payload: z.looseObject({
    sessionId: IdSchema,
    state: RunStateSchema,
    /** The durable operation the run is waiting on, for waiting states. */
    operationId: IdSchema.optional(),
    ...turnField
  })
});

export const AssistantDeltaEventSchema = z.looseObject({
  ...runScoped,
  type: z.literal("assistant.delta"),
  payload: z.looseObject({
    messageId: IdSchema,
    delta: z.string(),
    ...turnField
  })
});

export const AssistantMessageEventSchema = z.looseObject({
  ...runScoped,
  type: z.literal("assistant.message"),
  payload: z.looseObject({
    messageId: IdSchema,
    content: z.string(),
    ...turnField
  })
});

export const ToolStartedEventSchema = z.looseObject({
  ...runScoped,
  type: z.literal("tool.started"),
  payload: z.looseObject({
    toolCallId: IdSchema,
    toolName: z.string().min(1),
    input: JsonValueSchema.optional(),
    ...turnField
  })
});

export const ToolStatusSchema = z.enum(["ok", "error", "blocked", "cancelled"]);
export type ToolStatus = z.infer<typeof ToolStatusSchema>;

export const ToolFinishedEventSchema = z.looseObject({
  ...runScoped,
  type: z.literal("tool.finished"),
  payload: z.looseObject({
    toolCallId: IdSchema,
    toolName: z.string().min(1),
    status: ToolStatusSchema,
    durationMs: z.int().nonnegative().optional(),
    output: JsonValueSchema.optional(),
    error: z.string().optional(),
    cost: UsdcAmountSchema.optional(),
    ...turnField
  })
});

export const ArtifactCreatedEventSchema = z.looseObject({
  ...runScoped,
  type: z.literal("artifact.created"),
  payload: z.looseObject({
    artifactId: IdSchema,
    name: z.string().min(1),
    /** Path relative to the session's artifacts directory. */
    path: z.string().min(1),
    mimeType: z.string().min(1).optional(),
    sizeBytes: z.int().nonnegative().optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional()
  })
});

export const UsageUpdatedEventSchema = z.looseObject({
  ...runScoped,
  type: z.literal("usage.updated"),
  payload: z.looseObject({
    sessionId: IdSchema,
    limit: UsdcAmountSchema,
    spent: UsdcAmountSchema,
    reserved: UsdcAmountSchema,
    remaining: UsdcAmountSchema,
    llmSpent: UsdcAmountSchema.optional(),
    serviceSpent: UsdcAmountSchema.optional(),
    inputTokens: z.int().nonnegative().optional(),
    outputTokens: z.int().nonnegative().optional(),
    ...turnField
  })
});

export const ApprovalRequestSchema = z.looseObject({
  kind: z.enum(["purchase", "tool", "shell"]),
  serviceName: z.string().min(1).optional(),
  resourceUrl: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
  description: z.string().optional(),
  quotedAmount: UsdcAmountSchema.optional()
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalRequiredEventSchema = z.looseObject({
  ...runScoped,
  type: z.literal("approval.required"),
  payload: z.looseObject({
    /** Stable ID of the pending operation; echoed back by `run.resume`. */
    operationId: IdSchema,
    /** Stable digest of the immutable request description. */
    digest: z.string().min(1),
    request: ApprovalRequestSchema,
    expiresAt: TimestampSchema.optional()
  })
});

export const FundingRequiredEventSchema = z.looseObject({
  ...runScoped,
  type: z.literal("funding.required"),
  payload: z.looseObject({
    operationId: IdSchema,
    required: UsdcAmountSchema,
    available: UsdcAmountSchema,
    shortfall: UsdcAmountSchema,
    walletAddress: z.string().min(1).optional(),
    message: z.string().optional()
  })
});

export const DelegationProblemSchema = z.enum(["missing", "expired", "revoked", "cap_exceeded", "scope_insufficient"]);
export type DelegationProblem = z.infer<typeof DelegationProblemSchema>;

export const DelegationRequiredEventSchema = z.looseObject({
  ...runScoped,
  type: z.literal("delegation.required"),
  payload: z.looseObject({
    operationId: IdSchema,
    reason: DelegationProblemSchema,
    requiredAmount: UsdcAmountSchema.optional(),
    message: z.string().optional()
  })
});

/** A payment was signed/submitted but its result was lost; never retried blindly. */
export const PaymentUnknownEventSchema = z.looseObject({
  ...runScoped,
  type: z.literal("payment.unknown"),
  payload: z.looseObject({
    operationId: IdSchema,
    digest: z.string().min(1),
    resourceUrl: z.string().min(1),
    amount: UsdcAmountSchema,
    submittedAt: TimestampSchema,
    transactionHash: z.string().min(1).optional(),
    message: z.string().optional()
  })
});

export const CheckpointReasonSchema = z.enum(["waiting", "terminal", "cancel", "shutdown", "periodic"]);
export type CheckpointReason = z.infer<typeof CheckpointReasonSchema>;

export const CheckpointCompletedEventSchema = z.looseObject({
  ...runScoped,
  type: z.literal("checkpoint.completed"),
  payload: z.looseObject({
    checkpointId: IdSchema,
    sessionId: IdSchema,
    reason: CheckpointReasonSchema,
    /** Unresolved durable operations captured in the checkpoint. */
    pendingOperationIds: z.array(IdSchema)
  })
});

export const RunFinishedEventSchema = z.looseObject({
  ...runScoped,
  type: z.literal("run.finished"),
  payload: z.looseObject({
    sessionId: IdSchema,
    outcome: RunOutcomeSchema,
    summary: z.string().optional(),
    /** Checkpoint written before this outcome was emitted. */
    checkpointId: IdSchema.optional(),
    /** For waiting outcomes: the operation that must be resolved before `run.resume`. */
    pendingOperationId: IdSchema.optional(),
    turns: z.int().nonnegative().optional(),
    error: z.looseObject({ code: z.string().min(1), message: z.string() }).optional()
  })
});

export const RuntimeErrorEventSchema = z.looseObject({
  ...eventBase,
  type: z.literal("runtime.error"),
  commandId: IdSchema.optional(),
  runId: IdSchema.optional(),
  payload: z.looseObject({
    code: z.string().min(1),
    message: z.string(),
    /** Fatal errors are followed by a nonzero worker exit. */
    fatal: z.boolean(),
    details: JsonValueSchema.optional()
  })
});

export const EVENT_TYPES = [
  "worker.ready",
  "command.accepted",
  "command.rejected",
  "run.state",
  "assistant.delta",
  "assistant.message",
  "tool.started",
  "tool.finished",
  "artifact.created",
  "usage.updated",
  "approval.required",
  "funding.required",
  "delegation.required",
  "payment.unknown",
  "checkpoint.completed",
  "run.finished",
  "runtime.error"
] as const;
export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

export const EventSchema = z.discriminatedUnion("type", [
  WorkerReadyEventSchema,
  CommandAcceptedEventSchema,
  CommandRejectedEventSchema,
  RunStateEventSchema,
  AssistantDeltaEventSchema,
  AssistantMessageEventSchema,
  ToolStartedEventSchema,
  ToolFinishedEventSchema,
  ArtifactCreatedEventSchema,
  UsageUpdatedEventSchema,
  ApprovalRequiredEventSchema,
  FundingRequiredEventSchema,
  DelegationRequiredEventSchema,
  PaymentUnknownEventSchema,
  CheckpointCompletedEventSchema,
  RunFinishedEventSchema,
  RuntimeErrorEventSchema
]);
export type Event = z.infer<typeof EventSchema>;
export type EventOf<T extends EventType> = Extract<Event, { type: T }>;
export type EventPayload<T extends EventType> = EventOf<T>["payload"];
