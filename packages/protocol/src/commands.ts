import { z } from "zod";
import { PROTOCOL_VERSION } from "./version.js";
import { ApprovalModeSchema, BudgetSchema, IdSchema, ModelPolicySchema, SeqSchema, TimestampSchema } from "./primitives.js";
import { ResumeCauseSchema } from "./outcomes.js";

/**
 * Commands flow supervisor -> worker on stdin, one JSON object per line.
 * `id` is the command ID; the worker echoes it as `commandId` on events.
 */
const commandBase = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  id: IdSchema,
  seq: SeqSchema,
  emittedAt: TimestampSchema
};

export const SessionDirectiveSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("existing"), sessionId: IdSchema }),
  z.looseObject({ kind: z.literal("create"), sessionId: IdSchema.optional() })
]);
export type SessionDirective = z.infer<typeof SessionDirectiveSchema>;

export const RunStartCommandSchema = z.looseObject({
  ...commandBase,
  type: z.literal("run.start"),
  runId: IdSchema,
  payload: z.looseObject({
    session: SessionDirectiveSchema,
    prompt: z.string().min(1),
    modelPolicy: ModelPolicySchema,
    budget: BudgetSchema,
    approvalMode: ApprovalModeSchema,
    maxTurns: z.int().positive().optional()
  })
});

const FORBIDDEN_RESUME_KEYS = ["prompt", "messages"] as const;

export const RunResumeCommandSchema = z.looseObject({
  ...commandBase,
  type: z.literal("run.resume"),
  runId: IdSchema,
  payload: z
    .looseObject({
      sessionId: IdSchema,
      cause: ResumeCauseSchema,
      /** The durable operation (approval, purchase, delegation) that was resolved. */
      operationId: IdSchema.optional(),
      /** Checkpoint the supervisor expects the worker to resume from. */
      checkpointId: IdSchema.optional()
    })
    .refine((payload) => !FORBIDDEN_RESUME_KEYS.some((key) => key in payload), {
      error: "run.resume must not carry the original prompt or messages; the runtime resumes from its checkpoint"
    })
});

export const RunCancelCommandSchema = z.looseObject({
  ...commandBase,
  type: z.literal("run.cancel"),
  runId: IdSchema,
  payload: z.looseObject({
    reason: z.string().min(1)
  })
});
export const RunMessageCommandSchema = z.looseObject({
  ...commandBase, type: z.literal("run.message"), runId: IdSchema,
  payload: z.object({ prompt: z.string().min(1).max(100000) })
});

/** Checkpoint any active run, then exit. */
export const WorkerShutdownCommandSchema = z.looseObject({
  ...commandBase,
  type: z.literal("worker.shutdown"),
  payload: z.looseObject({
    reason: z.string().optional(),
    /** Time the worker may spend checkpointing before it must exit anyway. */
    gracePeriodMs: z.int().nonnegative().optional()
  })
});

export const COMMAND_TYPES = ["run.start", "run.resume", "run.cancel", "run.message", "worker.shutdown"] as const;
export const CommandTypeSchema = z.enum(COMMAND_TYPES);
export type CommandType = z.infer<typeof CommandTypeSchema>;

export const CommandSchema = z.discriminatedUnion("type", [
  RunStartCommandSchema,
  RunResumeCommandSchema,
  RunCancelCommandSchema,
  RunMessageCommandSchema,
  WorkerShutdownCommandSchema
]);
export type Command = z.infer<typeof CommandSchema>;
export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;
export type CommandPayload<T extends CommandType> = CommandOf<T>["payload"];
