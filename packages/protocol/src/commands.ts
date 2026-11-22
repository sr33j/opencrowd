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

/** A declared tool's wire name: `control.` and a lower-case name (C2). */
export const DECLARED_TOOL_NAME_PATTERN = /^control\.[a-z_]{1,40}$/;
export const MAX_DECLARED_TOOLS = 16;
export const MAX_RUN_INSTRUCTIONS = 8;
/** Every instruction section together, in UTF-8 bytes. */
export const MAX_RUN_INSTRUCTIONS_BYTES = 16 * 1024;
const utf8 = new TextEncoder();

/**
 * A tool control declares for one run. The runtime advertises it to the model
 * without the `control.` prefix and sends each call back over the supervisor
 * socket as `POST /tool {name: "control.<name>"}`; control decides on every
 * call whether this agent may use it, so declaring a tool grants nothing.
 */
export const DeclaredToolSchema = z.looseObject({
  name: z.string().regex(DECLARED_TOOL_NAME_PATTERN),
  description: z.string().min(1).max(4000),
  parameters: z.record(z.string(), z.unknown())
});
export type DeclaredTool = z.infer<typeof DeclaredToolSchema>;

/**
 * The owner's standing "take no action" rules, as control read them from the
 * org's rules.md and mission.md (SRI-166). The runtime refuses, from every
 * tool, requests that would change something on these sites: POST, PUT,
 * PATCH and DELETE, form submissions, and browser actions. Reading stays
 * allowed. A run without it is unrestricted, as before.
 */
export const ActionPolicySchema = z.object({
  /** Host suffixes (jobs.ashbyhq.com matches ashbyhq.com) where nothing may be changed. */
  noActionHosts: z.array(z.string().min(1).max(253)).max(300),
  /** "Information gathering only": no state-changing request to any ordinary website. Paid x402/MPP services stay usable. */
  readOnlyWeb: z.boolean(),
  /** The owner's words, quoted back in every refusal. */
  rule: z.string().min(1).max(600)
});
export type ActionPolicy = z.infer<typeof ActionPolicySchema>;

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
    maxTurns: z.int().positive().optional(),
    /**
     * Which capability tree (C7) the run reads: current (default), candidate,
     * or a version number. The tree gate pins a candidate this way.
     */
    treeVersion: z.string().regex(/^(current|candidate|\d{1,8})$/).optional(),
    /** Control's prompt sections, appended after the hosted system prompt. */
    instructions: z.array(z.string().min(1)).max(MAX_RUN_INSTRUCTIONS)
      .refine(sections => sections.reduce((total, section) => total + utf8.encode(section).length, 0) <= MAX_RUN_INSTRUCTIONS_BYTES,
        { error: `instructions exceed ${MAX_RUN_INSTRUCTIONS_BYTES} bytes in total` })
      .optional(),
    /** The owner's standing no-action rules, enforced by the runtime (SRI-166). */
    actionPolicy: ActionPolicySchema.optional(),
    /** Control-declared tools for this run (C2). */
    tools: z.array(DeclaredToolSchema).max(MAX_DECLARED_TOOLS)
      .refine(tools => new Set(tools.map(tool => tool.name)).size === tools.length, { error: "declared tool names must be unique" })
      .optional()
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
