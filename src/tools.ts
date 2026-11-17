import { z } from "zod";
import type { Contact, PropertyRepository } from "./db.js";
import type { ToolSpec } from "./model/provider.js";
import { senderMayAccessUnit } from "./rules.js";

/** Who the tools are running for. Set by code from the message's sender, never by the model. */
export interface ToolContext {
  sender: Contact | null;
}

/**
 * Read-only tools the context sub-agent may call. Each has a zod input schema;
 * arguments from the model are validated before any query runs, and a validation
 * failure is returned to the model as a tool error rather than thrown.
 *
 * Tools that return account data (lease, rent ledger, jobs) declare `accountUnit`: the unit
 * the data belongs to. executeTool refuses them unless the sender is that unit's resident or
 * its property's landlord, so another household's data never reaches the model at all.
 */
const tools = {
  find_contact_by_email: {
    description: "Look up the resident or landlord who sent the message, by their email address.",
    input: z.object({ email: z.string().email() }).strict(),
    run: (repo: PropertyRepository, a: { email: string }) => repo.findContactByEmail(a.email),
  },
  find_unit: {
    description: "Find a unit by property name and unit label (e.g. 'Ashgrove Court', 'Flat 3'). Returns null if it does not exist.",
    input: z.object({ property_name: z.string().min(2), unit_label: z.string().min(1) }).strict(),
    run: (repo: PropertyRepository, a: { property_name: string; unit_label: string }) => repo.findUnit(a.property_name, a.unit_label),
  },
  find_property: {
    description: "Find a property by name and list its unit labels. Returns null if it does not exist.",
    input: z.object({ property_name: z.string().min(2) }).strict(),
    run: (repo: PropertyRepository, a: { property_name: string }) => repo.findProperty(a.property_name),
  },
  get_unit: {
    description: "Get a unit and its property by unit id.",
    input: z.object({ unit_id: z.string().min(1) }).strict(),
    run: (repo: PropertyRepository, a: { unit_id: string }) => repo.getUnit(a.unit_id),
  },
  get_lease: {
    description: "Get the current lease for a unit id: dates, monthly rent and rent due day.",
    input: z.object({ unit_id: z.string().min(1) }).strict(),
    run: (repo: PropertyRepository, a: { unit_id: string }) => repo.getLease(a.unit_id),
    accountUnit: async (_repo: PropertyRepository, a: { unit_id: string }) => a.unit_id,
  },
  get_rent_ledger: {
    description: "Get rent ledger rows (due date, amount, paid) for a lease id.",
    input: z.object({ lease_id: z.string().min(1) }).strict(),
    run: (repo: PropertyRepository, a: { lease_id: string }) => repo.getRentLedger(a.lease_id),
    accountUnit: (repo: PropertyRepository, a: { lease_id: string }) => repo.getLeaseUnitId(a.lease_id),
  },
  get_open_work_orders: {
    description: "List open or scheduled work orders (jobs) for a unit id, including any booked visit time.",
    input: z.object({ unit_id: z.string().min(1) }).strict(),
    run: (repo: PropertyRepository, a: { unit_id: string }) => repo.getOpenWorkOrders(a.unit_id),
    accountUnit: async (_repo: PropertyRepository, a: { unit_id: string }) => a.unit_id,
  },
} as const;

export type ToolName = keyof typeof tools;
export const TOOL_NAMES = Object.keys(tools) as ToolName[];

export const TOOL_SPECS: ToolSpec[] = TOOL_NAMES.map((name) => {
  const schema = z.toJSONSchema(tools[name].input) as Record<string, unknown>;
  delete schema.$schema;
  return { name, description: tools[name].description, inputSchema: schema };
});

export interface ToolOutcome {
  ok: boolean;
  output: unknown;
  error?: string;
}

export const ACCESS_DENIED = "access denied: the sender is not the resident or landlord for this unit";

export async function executeTool(repo: PropertyRepository, name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  if (!Object.hasOwn(tools, name)) return { ok: false, output: null, error: `unknown tool '${name}'` };
  const tool = tools[name as ToolName];
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) {
    return { ok: false, output: null, error: `invalid arguments: ${z.prettifyError(parsed.error)}` };
  }
  if ("accountUnit" in tool) {
    const unitId = await (tool.accountUnit as (r: PropertyRepository, a: unknown) => Promise<string | null>)(repo, parsed.data);
    const unit = unitId ? await repo.getUnit(unitId) : null;
    // An id that matches nothing falls through and returns the tool's normal empty result.
    if (unit && !senderMayAccessUnit(ctx.sender, unit)) return { ok: false, output: null, error: ACCESS_DENIED };
  }
  // Each tool's run() accepts exactly its own parsed input type.
  const output = await (tool.run as (r: PropertyRepository, a: unknown) => Promise<unknown>)(repo, parsed.data);
  return { ok: true, output };
}
