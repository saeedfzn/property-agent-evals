import { z } from "zod";

export const Category = z.enum(["repair", "complaint", "rent", "lease", "general"]);
export const Urgency = z.enum(["emergency", "high", "normal", "low"]);
export const Hazard = z.enum(["gas", "carbon_monoxide", "electrical", "flood", "fire", "security", "none"]);
export type Category = z.infer<typeof Category>;
export type Urgency = z.infer<typeof Urgency>;
export type Hazard = z.infer<typeof Hazard>;

/** Sub-agent 1 output: classification + extraction from the raw message. */
export const Triage = z
  .object({
    category: Category,
    urgency: Urgency,
    hazard: Hazard,
    summary: z.string().min(3).max(200),
    mentioned_property: z.string().nullable(),
    mentioned_unit: z.string().nullable(),
  })
  .strict();
export type Triage = z.infer<typeof Triage>;

/** Sub-agent 2 output (after its tool loop): which records the message is about. */
export const ContextResolution = z
  .object({
    contact_id: z.string().nullable(),
    property_id: z.string().nullable(),
    unit_id: z.string().nullable(),
    lease_id: z.string().nullable(),
    related_job_ref: z.string().nullable(),
  })
  .strict();
export type ContextResolution = z.infer<typeof ContextResolution>;

/** Sub-agent 3 output: the reply draft for a human to review and send. */
export const ReplyDraft = z
  .object({
    reply: z.string().min(10).max(1500),
  })
  .strict();
export type ReplyDraft = z.infer<typeof ReplyDraft>;

export const WorkOrderProposal = z
  .object({
    status: z.literal("pending_approval"),
    requires_human_approval: z.literal(true),
    unit_id: z.string(),
    category: z.string(),
    description: z.string(),
    priority: z.enum(["P1", "P2", "P3", "P4"]),
    attend_within_hours: z.number().int().positive(),
  })
  .strict();
export type WorkOrderProposal = z.infer<typeof WorkOrderProposal>;

export const Span = z.object({
  name: z.string(),
  kind: z.enum(["model", "tool", "rule", "validation"]),
  ok: z.boolean(),
  latency_ms: z.number().nonnegative(),
  attempt: z.number().int().positive(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  note: z.string().optional(),
});
export type Span = z.infer<typeof Span>;

export const AgentResult = z
  .object({
    message_id: z.string(),
    prompt_version: z.string(),
    provider: z.string(),
    model: z.string(),
    status: z.enum(["ok", "needs_human"]),
    category: Category,
    urgency: Urgency,
    model_urgency: Urgency,
    hazard: Hazard,
    rule_hazard: Hazard,
    property_id: z.string().nullable(),
    unit_id: z.string().nullable(),
    related_job_ref: z.string().nullable(),
    sla: z.object({ respond_within_hours: z.number(), attend_within_hours: z.number().nullable(), escalate_to_on_call: z.boolean() }),
    reply: z.string(),
    work_order_proposal: WorkOrderProposal.nullable(),
    schema_failures: z.number().int().nonnegative(),
    grounding_rejections: z.array(z.string()),
    errors: z.array(z.string()),
    trace: z.object({
      spans: z.array(Span),
      total_latency_ms: z.number().nonnegative(),
      total_input_tokens: z.number().int().nonnegative(),
      total_output_tokens: z.number().int().nonnegative(),
      total_cost_usd: z.number().nonnegative(),
    }),
  })
  .strict();
export type AgentResult = z.infer<typeof AgentResult>;

export interface InboundMessage {
  id: string;
  from: string;
  received_at: string;
  body: string;
}
