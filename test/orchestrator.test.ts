import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { triageMessage } from "../src/agents/orchestrator.js";
import { approveWorkOrder } from "../src/db.js";
import { FixtureProvider } from "../src/model/fixture.js";
import { TransientModelError } from "../src/model/provider.js";
import { AgentResult } from "../src/schemas.js";
import { ACCESS_DENIED, executeTool } from "../src/tools.js";
import { cleanFixture, freshRepo, NOW, OverrideProvider, textResponse } from "./helpers.js";

let db: PGlite | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

const msg = (body: string, from = "priya.l@example.com") => ({ id: "t1", from, received_at: NOW.toISOString(), body });

describe("orchestrator", () => {
  it("a gas smell is an emergency even when the model says routine", async () => {
    const fresh = await freshRepo();
    db = fresh.db;
    const provider = new OverrideProvider(cleanFixture(), (req) =>
      req.task === "classify"
        ? textResponse(JSON.stringify({ category: "repair", urgency: "low", hazard: "none", summary: "Odd smell in kitchen", mentioned_property: null, mentioned_unit: null }))
        : null,
    );
    const r = await triageMessage({ provider, repo: fresh.repo, promptVersion: "v2", now: NOW }, msg("I can smell gas near the hob"));
    expect(r.model_urgency).toBe("low");
    expect(r.urgency).toBe("emergency");
    expect(r.hazard).toBe("gas");
    expect(r.sla.escalate_to_on_call).toBe(true);
    expect(r.reply.startsWith("SAFETY FIRST")).toBe(true);
    expect(r.work_order_proposal).toMatchObject({ priority: "P1", status: "pending_approval", requires_human_approval: true });
  });

  it("rejects invalid structured output and retries once with the error fed back", async () => {
    const fresh = await freshRepo();
    db = fresh.db;
    let repairPrompt = "";
    const provider = new OverrideProvider(cleanFixture(), (req, n) => {
      if (req.task !== "classify") return null;
      if (n === 1) return textResponse('{"category": "plumbing", "urgency": "soon"}');
      const last = req.transcript.at(-1);
      if (last?.role === "user") repairPrompt = last.text;
      return null;
    });
    const r = await triageMessage({ provider, repo: fresh.repo, promptVersion: "v2", now: NOW }, msg("My kitchen tap is dripping", "t.okafor@example.com"));
    expect(r.schema_failures).toBe(1);
    expect(repairPrompt).toContain("rejected");
    expect(r.status).toBe("ok");
    expect(r.category).toBe("repair");
  });

  it("two invalid outputs degrade safely to needs_human with a holding reply", async () => {
    const fresh = await freshRepo();
    db = fresh.db;
    const provider = new OverrideProvider(cleanFixture(), (req) => (req.task === "draft_reply" ? textResponse("not json at all") : null));
    const r = await triageMessage({ provider, repo: fresh.repo, promptVersion: "v2", now: NOW }, msg("My kitchen tap is dripping", "t.okafor@example.com"));
    expect(r.status).toBe("needs_human");
    expect(r.schema_failures).toBe(2);
    expect(r.reply).toContain("A member of our team will review it");
  });

  it("retries transient model errors and traces the failed attempt", async () => {
    const fresh = await freshRepo();
    db = fresh.db;
    const provider = new OverrideProvider(cleanFixture(), (req, n) => {
      if (req.task === "classify" && n === 1) throw new TransientModelError("simulated 529 overloaded");
      return null;
    });
    const r = await triageMessage({ provider, repo: fresh.repo, promptVersion: "v2", now: NOW }, msg("My kitchen tap is dripping", "t.okafor@example.com"));
    const classifySpans = r.trace.spans.filter((s) => s.name === "classify");
    expect(classifySpans.map((s) => [s.attempt, s.ok])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(r.status).toBe("ok");
  });

  it("drops ids the context model invented (grounding check)", async () => {
    const fresh = await freshRepo();
    db = fresh.db;
    const provider = new OverrideProvider(cleanFixture(), (req) => {
      if (req.task !== "gather_context") return null;
      // Answer immediately, without calling any tool, with made-up ids.
      return textResponse(JSON.stringify({ contact_id: "R99", property_id: "P-ASH", unit_id: "U-ASH-9", lease_id: null, related_job_ref: "WO-7777" }));
    });
    const r = await triageMessage({ provider, repo: fresh.repo, promptVersion: "v2", now: NOW }, msg("My radiator is cold", "dev.marlowe@example.com"));
    expect(r.grounding_rejections).toEqual(["contact_id=R99", "property_id=P-ASH", "unit_id=U-ASH-9", "related_job_ref=WO-7777"]);
    expect(r.unit_id).toBeNull();
    expect(r.work_order_proposal).toBeNull();
    expect(r.status).toBe("needs_human");
  });

  it("a model outage on a gas message still returns the emergency, safety wording and on-call escalation", async () => {
    const fresh = await freshRepo();
    db = fresh.db;
    const provider = new OverrideProvider(cleanFixture(), () => {
      throw new TransientModelError("simulated 529 overloaded");
    });
    const r = await triageMessage({ provider, repo: fresh.repo, promptVersion: "v2", now: NOW }, msg("I can smell gas near the hob"));
    expect(r.status).toBe("needs_human");
    expect(r.urgency).toBe("emergency");
    expect(r.sla.escalate_to_on_call).toBe(true);
    expect(r.reply.startsWith("SAFETY FIRST")).toBe(true);
    expect(r.reply).toContain("0800 111 999");
    expect(r.errors.join(" | ")).toMatch(/classify failed: model call failed.*context: model call failed.*draft failed: model call failed/);
    // 3 attempts for classify, 3 for the first context step, 3 for the draft: every one traced as failed.
    expect(r.trace.spans.filter((s) => s.kind === "model").map((s) => s.ok)).toEqual(Array(9).fill(false));
  });

  it("a non-retryable model error (bad request) also degrades to needs_human instead of throwing", async () => {
    const fresh = await freshRepo();
    db = fresh.db;
    const provider = new OverrideProvider(cleanFixture(), (req) => {
      if (req.task === "draft_reply") throw new Error("400 invalid_request_error");
      return null;
    });
    const r = await triageMessage({ provider, repo: fresh.repo, promptVersion: "v2", now: NOW }, msg("My kitchen tap is dripping", "t.okafor@example.com"));
    expect(r.status).toBe("needs_human");
    expect(r.related_job_ref).toBe("WO-1001");
    expect(r.reply).toContain("A member of our team will review it");
    expect(r.trace.spans.filter((s) => s.name === "draft_reply")).toHaveLength(1); // not retried
  });

  it("a refusal from the context sub-agent degrades to needs_human", async () => {
    const fresh = await freshRepo();
    db = fresh.db;
    const provider = new OverrideProvider(cleanFixture(), (req) => (req.task === "gather_context" ? { ...textResponse(""), stopReason: "refusal" } : null));
    const r = await triageMessage({ provider, repo: fresh.repo, promptVersion: "v2", now: NOW }, msg("My radiator is cold", "dev.marlowe@example.com"));
    expect(r.status).toBe("needs_human");
    expect(r.errors).toContain("context: model refused");
    expect(r.unit_id).toBeNull();
  });

  it("prices each call by the model that served it, and notes a server-side fallback in the trace", async () => {
    const fresh = await freshRepo();
    db = fresh.db;
    const provider = new OverrideProvider(cleanFixture(), (req) =>
      req.task === "draft_reply" ? { ...textResponse(JSON.stringify({ reply: "Hello, thank you for your message." })), usage: { inputTokens: 1_000_000, outputTokens: 0 }, model: "claude-sonnet-5-5" } : null,
    );
    const r = await triageMessage({ provider, repo: fresh.repo, promptVersion: "v2", now: NOW }, msg("Thanks for sorting the boiler", "hannah.brecken@example.com"));
    const span = r.trace.spans.find((s) => s.name === "draft_reply")!;
    expect(span.cost_usd).toBe(2); // Sonnet 5.5 input price, not the requested Opus 5.5 price (4)
    expect(span.note).toBe("served by claude-sonnet-5-5");
  });

  it("quotes a real booked visit for an existing job instead of proposing a duplicate", async () => {
    const fresh = await freshRepo();
    db = fresh.db;
    const r = await triageMessage({ provider: cleanFixture(), repo: fresh.repo, promptVersion: "v2", now: NOW }, msg("The kitchen tap is still dripping", "t.okafor@example.com"));
    expect(r.related_job_ref).toBe("WO-1001");
    expect(r.work_order_proposal).toBeNull();
    expect(r.reply).toContain("Thursday 19 November at 10:00");
    expect(() => AgentResult.parse(r)).not.toThrow();
  });

  it("v1 prompt invents a visit date; v2 does not", async () => {
    const fresh = await freshRepo();
    db = fresh.db;
    const body = msg("My radiator in the living room is cold at the top", "dev.marlowe@example.com");
    const v1 = await triageMessage({ provider: cleanFixture(), repo: fresh.repo, promptVersion: "v1", now: NOW }, body);
    const v2 = await triageMessage({ provider: cleanFixture(), repo: fresh.repo, promptVersion: "v2", now: NOW }, body);
    expect(v1.reply).toMatch(/visit .* on \w+day \d+ November/);
    expect(v2.reply).not.toMatch(/\d+ November/);
    expect(v2.reply).toContain("will confirm the appointment once it is booked");
  });
});

describe("sender access (code-enforced, whatever unit the model resolves)", () => {
  it("an unknown sender naming a real flat gets no rent figures", async () => {
    const fresh = await freshRepo();
    db = fresh.db;
    const r = await triageMessage(
      { provider: cleanFixture(), repo: fresh.repo, promptVersion: "v2", now: NOW },
      msg("How much rent do I owe for Flat 2 at Ashgrove Court?", "new.tenant.query@example.com"),
    );
    expect(r.unit_id).toBe("U-ASH-2"); // the model did resolve the flat from the text
    expect(r.status).toBe("needs_human");
    expect(r.reply).not.toMatch(/£|December/);
    expect(r.errors).toContain("sender is not the resident or landlord for U-ASH-2: account data withheld");
    expect(r.trace.spans.some((s) => s.name === "load:lease" || s.name === "load:ledger")).toBe(false);
    // The model asked for the lease; the tool refused, so the figures never reached the model either.
    expect(r.trace.spans.filter((s) => s.name === "tool:get_lease").map((s) => [s.ok, s.note])).toEqual([[false, ACCESS_DENIED]]);
    expect(r.trace.spans.some((s) => s.name === "tool:get_rent_ledger")).toBe(false);
  });

  it("account tools refuse a sender who is not linked to the unit, whatever ids the model passes", async () => {
    const fresh = await freshRepo();
    db = fresh.db;
    const priya = await fresh.repo.findContactByEmail("priya.l@example.com"); // resident of U-ASH-1
    const landlord = await fresh.repo.findContactByEmail("marian.thistlewood@example.com"); // owns Ashgrove + Bramblewick
    const denied = { ok: false, output: null, error: ACCESS_DENIED };
    for (const sender of [null, priya]) {
      expect(await executeTool(fresh.repo, "get_lease", { unit_id: "U-ASH-2" }, { sender })).toEqual(denied);
      expect(await executeTool(fresh.repo, "get_rent_ledger", { lease_id: "LS-02" }, { sender })).toEqual(denied);
      expect(await executeTool(fresh.repo, "get_open_work_orders", { unit_id: "U-ASH-2" }, { sender })).toEqual(denied);
    }
    expect((await executeTool(fresh.repo, "get_lease", { unit_id: "U-ASH-1" }, { sender: priya })).ok).toBe(true);
    expect((await executeTool(fresh.repo, "get_rent_ledger", { lease_id: "LS-02" }, { sender: landlord })).ok).toBe(true);
    expect(await executeTool(fresh.repo, "get_rent_ledger", { lease_id: "LS-10" }, { sender: landlord })).toEqual(denied); // Cinderfield: another landlord
    // Looking up which flat exists is not account data.
    expect((await executeTool(fresh.repo, "find_unit", { property_name: "Ashgrove Court", unit_label: "Flat 2" }, { sender: null })).ok).toBe(true);
  });

  it("a resident naming another resident's flat gets no lease date, on either prompt version", async () => {
    for (const promptVersion of ["v1", "v2"] as const) {
      const fresh = await freshRepo();
      const r = await triageMessage(
        { provider: cleanFixture(), repo: fresh.repo, promptVersion, now: NOW },
        msg("When does the tenancy end for Flat 3 at Cinderfield Mews? I want to renew"),
      );
      await fresh.db.close();
      expect(r.status).toBe("needs_human");
      expect(r.reply).not.toMatch(/January|2027/);
    }
  });

  it("a resident in the same building is not treated as that building's landlord", async () => {
    const fresh = await freshRepo();
    db = fresh.db;
    const r = await triageMessage(
      { provider: cleanFixture(), repo: fresh.repo, promptVersion: "v2", now: NOW },
      msg("Is the plumber still coming to Flat 2 at Ashgrove Court for the dripping tap?"),
    );
    expect(r.status).toBe("needs_human");
    expect(r.related_job_ref).toBeNull();
    expect(r.reply).not.toMatch(/WO-1001|19 November|Kestrelford/);
    expect(r.work_order_proposal).toBeNull();
    expect(r.trace.spans.find((s) => s.name === "tool:get_open_work_orders")).toMatchObject({ ok: false, note: ACCESS_DENIED });
  });

  it("the landlord of the property is allowed, and a neighbour's emergency report is still proposed", async () => {
    const fresh = await freshRepo();
    db = fresh.db;
    const landlord = await triageMessage(
      { provider: cleanFixture(), repo: fresh.repo, promptVersion: "v2", now: NOW },
      msg("Can you confirm whether rent has been received for Flat 2 at Ashgrove Court this month?", "marian.thistlewood@example.com"),
    );
    expect(landlord.status).toBe("ok");
    expect(landlord.reply).toContain("received in full");
    const neighbour = await triageMessage(
      { provider: cleanFixture(), repo: fresh.repo, promptVersion: "v2", now: NOW },
      msg("I can smell gas coming from Flat 2 at Ashgrove Court"),
    );
    expect(neighbour.urgency).toBe("emergency");
    expect(neighbour.status).toBe("needs_human");
    expect(neighbour.work_order_proposal).toMatchObject({ unit_id: "U-ASH-2", priority: "P1", requires_human_approval: true });
  });
});

describe("timezone independence", () => {
  it.each(["Pacific/Auckland", "America/Los_Angeles"])("rent and lease dates are identical in %s", async (tz) => {
    const saved = process.env.TZ;
    process.env.TZ = tz;
    try {
      const fresh = await freshRepo();
      db = fresh.db;
      const rent = await triageMessage({ provider: cleanFixture(), repo: fresh.repo, promptVersion: "v2", now: NOW }, msg("How much rent do I owe and when is it due?", "aoife.c@example.com"));
      expect(rent.reply).toContain("£1,150.00 is due on Tuesday 1 December");
      const lease = await fresh.repo.getLease("U-CIN-3");
      expect(lease?.end_date).toBe("2027-01-09");
    } finally {
      process.env.TZ = saved;
      if (saved === undefined) delete process.env.TZ;
    }
  });
});

describe("human approval and data safety", () => {
  it("a full golden-set run writes no work orders", async () => {
    const fresh = await freshRepo();
    db = fresh.db;
    const lines = (await readFile("evals/golden/cases.jsonl", "utf8")).split("\n").filter(Boolean);
    const before = await fresh.repo.countWorkOrders();
    const provider = new FixtureProvider();
    let proposals = 0;
    for (const line of lines) {
      const c = JSON.parse(line) as { id: string; input: { from: string; received_at: string; body: string } };
      const r = await triageMessage({ provider, repo: fresh.repo, promptVersion: "v2", now: NOW }, { id: c.id, ...c.input });
      if (r.work_order_proposal) {
        proposals++;
        expect(r.work_order_proposal.requires_human_approval).toBe(true);
      }
    }
    expect(proposals).toBeGreaterThan(5);
    expect(await fresh.repo.countWorkOrders()).toBe(before);
  });

  it("only approveWorkOrder writes, and it requires a named approver", async () => {
    const fresh = await freshRepo();
    db = fresh.db;
    const proposal = { unit_id: "U-ASH-5", category: "repair", description: "Radiator cold at top", priority: "P3" as const };
    await expect(approveWorkOrder(fresh.db, proposal, "  ", NOW)).rejects.toThrow(/approver/);
    const wo = await approveWorkOrder(fresh.db, proposal, "ops.lead@example.com", NOW);
    expect(wo.job_ref).toBe("WO-1006");
    expect((await fresh.repo.getOpenWorkOrders("U-ASH-5")).map((w) => w.job_ref)).toEqual(["WO-1006"]);
  });

  it("concurrent approvals never share a job reference", async () => {
    const fresh = await freshRepo();
    db = fresh.db;
    const proposal = { unit_id: "U-ASH-5", category: "repair", description: "Radiator cold at top", priority: "P3" as const };
    const refs = await Promise.all([1, 2, 3, 4, 5].map((i) => approveWorkOrder(fresh.db, proposal, `ops${i}@example.com`, NOW)));
    expect(new Set(refs.map((r) => r.job_ref)).size).toBe(5);
    await expect(approveWorkOrder(fresh.db, { ...proposal, unit_id: "U-NOPE-1" }, "ops@example.com", NOW)).rejects.toThrow();
  });

  it("tool arguments are validated, and queries are parameterised", async () => {
    const fresh = await freshRepo();
    db = fresh.db;
    const bad = await executeTool(fresh.repo, "find_contact_by_email", { email: "not-an-email" }, { sender: null });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/invalid arguments/);
    const unknown = await executeTool(fresh.repo, "drop_tables", {}, { sender: null });
    expect((await executeTool(fresh.repo, "constructor", {}, { sender: null })).ok).toBe(false);
    expect(unknown.ok).toBe(false);
    const injection = await executeTool(fresh.repo, "find_unit", { property_name: "x' OR '1'='1", unit_label: "Flat 1'; DROP TABLE units; --" }, { sender: null });
    expect(injection).toEqual({ ok: true, output: null });
    expect(await fresh.repo.getUnit("U-ASH-1")).not.toBeNull();
  });
});
