import { z } from "zod";

export const planStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed", "blocked"])
});

export type PlanStep = z.infer<typeof planStepSchema>;

export const authSessionSchema = z.object({
  userId: z.string().min(1),
  username: z.string().min(1),
  expiresAt: z.string().datetime()
});

export type AuthSession = z.infer<typeof authSessionSchema>;

export const loginInputSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(8)
});

export type LoginInput = z.infer<typeof loginInputSchema>;

export const conversationSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  titleSource: z.enum(["initial", "auto", "manual"]).default("manual"),
  archivedAt: z.string().datetime().nullable().default(null),
  lastRunStatus: z.enum(["unknown", "completed", "failed"]).default("unknown"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export type Conversation = z.infer<typeof conversationSchema>;

export const messageSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  createdAt: z.string().datetime()
});

export type Message = z.infer<typeof messageSchema>;

export const commandExecutionSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().min(1),
  currentCwd: z.string().min(1).optional(),
  exitCode: z.number().int(),
  timedOut: z.boolean().optional(),
  truncated: z.boolean(),
  outputPreview: z.string(),
  outputPath: z.string().optional(),
  durationMs: z.number().int().nonnegative()
});

export type CommandExecution = z.infer<typeof commandExecutionSchema>;

export const providerConfigSchema = z.object({
  providerId: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["openai_compatible"]),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  supportsReasoning: z.boolean().default(true)
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export const eventChannelSchema = z.enum(["agent", "terminal"]);

export type EventChannel = z.infer<typeof eventChannelSchema>;

export const agentEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run_queued"),
    runId: z.string().min(1),
    at: z.string().datetime(),
    channel: eventChannelSchema.default("agent"),
    messageId: z.string().min(1).optional()
  }),
  z.object({
    type: z.literal("run_started"),
    runId: z.string().min(1),
    at: z.string().datetime(),
    channel: eventChannelSchema.default("agent")
  }),
  z.object({
    type: z.literal("plan_updated"),
    runId: z.string().min(1),
    at: z.string().datetime(),
    channel: eventChannelSchema.default("agent"),
    steps: z.array(planStepSchema)
  }),
  z.object({
    type: z.literal("thinking"),
    runId: z.string().min(1),
    at: z.string().datetime(),
    channel: eventChannelSchema.default("agent"),
    text: z.string()
  }),
  z.object({
    type: z.literal("message_delta"),
    runId: z.string().min(1),
    at: z.string().datetime(),
    channel: eventChannelSchema.default("agent"),
    text: z.string()
  }),
  z.object({
    type: z.literal("command_started"),
    runId: z.string().min(1),
    at: z.string().datetime(),
    channel: eventChannelSchema.default("agent"),
    id: z.string().min(1),
    command: z.string().min(1),
    cwd: z.string().min(1)
  }),
  z.object({
    type: z.literal("command_completed"),
    runId: z.string().min(1),
    at: z.string().datetime(),
    channel: eventChannelSchema.default("agent"),
    execution: commandExecutionSchema
  }),
  z.object({
    type: z.literal("assistant_message"),
    runId: z.string().min(1),
    at: z.string().datetime(),
    channel: eventChannelSchema.default("agent"),
    message: messageSchema
  }),
  z.object({
    type: z.literal("run_completed"),
    runId: z.string().min(1),
    at: z.string().datetime(),
    channel: eventChannelSchema.default("agent")
  }),
  z.object({
    type: z.literal("run_failed"),
    runId: z.string().min(1),
    at: z.string().datetime(),
    channel: eventChannelSchema.default("agent"),
    error: z.string()
  })
]);

export type AgentEvent = z.infer<typeof agentEventSchema>;

export const sendMessageInputSchema = z.object({
  conversationId: z.string().min(1),
  content: z.string().min(1),
  providerId: z.string().min(1).default("default")
});

export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;

export const queueMessageResponseSchema = z.object({
  accepted: z.literal(true),
  conversationId: z.string().min(1),
  runId: z.string().min(1),
  queuedAt: z.string().datetime(),
  message: messageSchema
});

export type QueueMessageResponse = z.infer<typeof queueMessageResponseSchema>;

export const createConversationInputSchema = z.object({
  title: z.string().min(1).max(120)
});

export type CreateConversationInput = z.infer<typeof createConversationInputSchema>;

export const updateConversationInputSchema = z
  .object({
    title: z.string().min(1).max(120).optional(),
    archived: z.boolean().optional()
  })
  .refine((value) => value.title !== undefined || value.archived !== undefined, {
    message: "title or archived is required"
  });

export type UpdateConversationInput = z.infer<typeof updateConversationInputSchema>;

export const resetConversationResponseSchema = z.object({
  ok: z.literal(true),
  conversation: conversationSchema
});

export type ResetConversationResponse = z.infer<typeof resetConversationResponseSchema>;

export const terminalCommandInputSchema = z.object({
  conversationId: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().min(1).optional()
});

export type TerminalCommandInput = z.infer<typeof terminalCommandInputSchema>;

export const terminalCommandResponseSchema = z.object({
  accepted: z.literal(true),
  conversationId: z.string().min(1),
  runId: z.string().min(1),
  queuedAt: z.string().datetime(),
  currentCwd: z.string().min(1),
  channel: z.literal("terminal").default("terminal")
});

export type TerminalCommandResponse = z.infer<typeof terminalCommandResponseSchema>;

export const agentDecisionSchema = z.object({
  reasoning: z.string().default(""),
  plan: z.array(planStepSchema).default([]),
  action: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("run_command"),
      command: z.string().min(1),
      cwd: z.string().min(1).default(".")
    }),
    z.object({
      type: z.literal("final_answer"),
      message: z.string().min(1)
    })
  ])
});

export type AgentDecision = z.infer<typeof agentDecisionSchema>;
