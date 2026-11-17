import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, "..", "db", "migrations");

/** Opens an in-memory Postgres (PGlite) and applies every migration in order. */
export async function openDatabase(migrationsDir: string = MIGRATIONS_DIR): Promise<PGlite> {
  const db = new PGlite();
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    await db.exec(sql);
  }
  return db;
}

export interface Contact {
  kind: "resident" | "landlord";
  id: string;
  full_name: string;
  email: string;
  unit_id: string | null;
  property_ids: string[];
}

export interface UnitRecord {
  unit_id: string;
  unit_label: string;
  property_id: string;
  property_name: string;
  postcode: string;
}

export interface LeaseRecord {
  lease_id: string;
  unit_id: string;
  resident_id: string;
  start_date: string;
  end_date: string;
  monthly_rent_pence: number;
  rent_due_day: number;
}

export interface LedgerRecord {
  due_date: string;
  amount_pence: number;
  paid_pence: number;
  paid_on: string | null;
}

export interface WorkOrderRecord {
  job_ref: string;
  unit_id: string;
  category: string;
  description: string;
  status: string;
  priority: string;
  contractor_name: string | null;
  scheduled_for: string | null;
}

const iso = (d: unknown): string | null => {
  if (d === null || d === undefined) return null;
  if (d instanceof Date) return d.toISOString();
  return String(d);
};
const isoDate = (d: unknown): string | null => {
  const s = iso(d);
  return s === null ? null : s.slice(0, 10);
};

// Dates are returned as 'YYYY-MM-DD' text from SQL, so results never depend on the host timezone.

/**
 * Read-only data access used by the agent's tools. Every query is parameterised;
 * no string interpolation of user- or model-supplied values ever reaches SQL.
 */
export class PropertyRepository {
  constructor(private readonly db: PGlite) {}

  async findContactByEmail(email: string): Promise<Contact | null> {
    const r = await this.db.query<{ id: string; full_name: string; email: string; unit_id: string; property_id: string }>(
      `SELECT r.id, r.full_name, r.email, r.unit_id, u.property_id
         FROM residents r JOIN units u ON u.id = r.unit_id
        WHERE lower(r.email) = lower($1)`,
      [email],
    );
    const row = r.rows[0];
    if (row) {
      return { kind: "resident", id: row.id, full_name: row.full_name, email: row.email, unit_id: row.unit_id, property_ids: [row.property_id] };
    }
    const l = await this.db.query<{ id: string; name: string; email: string; property_ids: string[] | null }>(
      `SELECT l.id, l.name, l.email, array_agg(p.id ORDER BY p.id) AS property_ids
         FROM landlords l LEFT JOIN properties p ON p.landlord_id = l.id
        WHERE lower(l.email) = lower($1)
        GROUP BY l.id, l.name, l.email`,
      [email],
    );
    const lrow = l.rows[0];
    if (!lrow) return null;
    return { kind: "landlord", id: lrow.id, full_name: lrow.name, email: lrow.email, unit_id: null, property_ids: lrow.property_ids ?? [] };
  }

  async findUnit(propertyName: string, unitLabel: string): Promise<UnitRecord | null> {
    const r = await this.db.query<UnitRecord>(
      `SELECT u.id AS unit_id, u.label AS unit_label, p.id AS property_id, p.name AS property_name, p.postcode
         FROM units u JOIN properties p ON p.id = u.property_id
        WHERE lower(p.name) = lower($1) AND lower(u.label) = lower($2)`,
      [propertyName.trim(), unitLabel.trim()],
    );
    return r.rows[0] ?? null;
  }

  async findProperty(propertyName: string): Promise<{ property_id: string; property_name: string; unit_labels: string[] } | null> {
    const r = await this.db.query<{ property_id: string; property_name: string; unit_labels: string[] }>(
      `SELECT p.id AS property_id, p.name AS property_name, array_agg(u.label ORDER BY u.label) AS unit_labels
         FROM properties p JOIN units u ON u.property_id = p.id
        WHERE lower(p.name) = lower($1)
        GROUP BY p.id, p.name`,
      [propertyName.trim()],
    );
    return r.rows[0] ?? null;
  }

  async getUnit(unitId: string): Promise<UnitRecord | null> {
    const r = await this.db.query<UnitRecord>(
      `SELECT u.id AS unit_id, u.label AS unit_label, p.id AS property_id, p.name AS property_name, p.postcode
         FROM units u JOIN properties p ON p.id = u.property_id
        WHERE u.id = $1`,
      [unitId],
    );
    return r.rows[0] ?? null;
  }

  async getLease(unitId: string): Promise<LeaseRecord | null> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT id AS lease_id, unit_id, resident_id, to_char(start_date, 'YYYY-MM-DD') AS start_date,
              to_char(end_date, 'YYYY-MM-DD') AS end_date, monthly_rent_pence, rent_due_day
         FROM leases WHERE unit_id = $1 ORDER BY start_date DESC LIMIT 1`,
      [unitId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      lease_id: String(row.lease_id),
      unit_id: String(row.unit_id),
      resident_id: String(row.resident_id),
      start_date: isoDate(row.start_date) ?? "",
      end_date: isoDate(row.end_date) ?? "",
      monthly_rent_pence: Number(row.monthly_rent_pence),
      rent_due_day: Number(row.rent_due_day),
    };
  }

  async getLeaseUnitId(leaseId: string): Promise<string | null> {
    const r = await this.db.query<{ unit_id: string }>(`SELECT unit_id FROM leases WHERE id = $1`, [leaseId]);
    return r.rows[0]?.unit_id ?? null;
  }

  async getRentLedger(leaseId: string): Promise<LedgerRecord[]> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT to_char(due_date, 'YYYY-MM-DD') AS due_date, amount_pence, paid_pence, to_char(paid_on, 'YYYY-MM-DD') AS paid_on
         FROM rent_ledger WHERE lease_id = $1 ORDER BY due_date`,
      [leaseId],
    );
    return r.rows.map((row) => ({
      due_date: isoDate(row.due_date) ?? "",
      amount_pence: Number(row.amount_pence),
      paid_pence: Number(row.paid_pence),
      paid_on: isoDate(row.paid_on),
    }));
  }

  async getOpenWorkOrders(unitId: string): Promise<WorkOrderRecord[]> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT w.id AS job_ref, w.unit_id, w.category, w.description, w.status, w.priority,
              c.name AS contractor_name, w.scheduled_for
         FROM work_orders w LEFT JOIN contractors c ON c.id = w.contractor_id
        WHERE w.unit_id = $1 AND w.status IN ('open', 'scheduled')
        ORDER BY w.created_at`,
      [unitId],
    );
    return r.rows.map((row) => ({
      job_ref: String(row.job_ref),
      unit_id: String(row.unit_id),
      category: String(row.category),
      description: String(row.description),
      status: String(row.status),
      priority: String(row.priority),
      contractor_name: row.contractor_name === null ? null : String(row.contractor_name),
      scheduled_for: iso(row.scheduled_for),
    }));
  }

  async countWorkOrders(): Promise<number> {
    const r = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM work_orders`);
    return r.rows[0]?.n ?? 0;
  }

  /**
   * A read-only export of the facts a reply may be grounded in. The Python graders
   * check reply text against this, so they never have to trust the agent's own output.
   */
  async snapshot(): Promise<Record<string, unknown>> {
    const q = async (sql: string) => (await this.db.query<Record<string, unknown>>(sql)).rows;
    const normalise = (rows: Record<string, unknown>[]) =>
      rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]),
        ),
      );
    return {
      properties: normalise(await q(`SELECT id, name, postcode, landlord_id FROM properties ORDER BY id`)),
      units: normalise(await q(`SELECT id, property_id, label FROM units ORDER BY id`)),
      residents: normalise(await q(`SELECT id, full_name, email, unit_id FROM residents ORDER BY id`)),
      landlords: normalise(await q(`SELECT id, name, email FROM landlords ORDER BY id`)),
      leases: normalise(
        await q(`SELECT id, unit_id, resident_id, to_char(start_date, 'YYYY-MM-DD') AS start_date,
                        to_char(end_date, 'YYYY-MM-DD') AS end_date, monthly_rent_pence, rent_due_day
                   FROM leases ORDER BY id`),
      ),
      rent_ledger: normalise(
        await q(`SELECT lease_id, to_char(due_date, 'YYYY-MM-DD') AS due_date, amount_pence, paid_pence
                   FROM rent_ledger ORDER BY lease_id, due_date`),
      ),
      contractors: normalise(await q(`SELECT id, name, trade FROM contractors ORDER BY id`)),
      work_orders: normalise(
        await q(`SELECT id, unit_id, category, status, contractor_id,
                        to_char(scheduled_for AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') AS scheduled_for
                   FROM work_orders ORDER BY id`),
      ),
    };
  }
}

export interface ApprovedWorkOrder {
  job_ref: string;
  approved_by: string;
}

/**
 * The ONLY write path for work orders. The agent never calls this: it returns a
 * proposal, and a named human approves it (from an ops UI, not from the model).
 */
export async function approveWorkOrder(
  db: PGlite,
  proposal: { unit_id: string; category: string; description: string; priority: "P1" | "P2" | "P3" | "P4" },
  approvedBy: string,
  now: Date,
): Promise<ApprovedWorkOrder> {
  if (!approvedBy.trim()) throw new Error("approvedBy is required: work orders need a named human approver");
  // One statement, with the reference taken from a sequence: two approvals at the same
  // moment can never be given the same job reference (max(id)+1 in application code could).
  const r = await db.query<{ id: string }>(
    `INSERT INTO work_orders (id, unit_id, category, description, status, priority, created_at, approved_by)
     VALUES ('WO-' || nextval('work_order_ref_seq'), $1, $2, $3, 'open', $4, $5, $6)
     RETURNING id`,
    [proposal.unit_id, proposal.category, proposal.description, proposal.priority, now.toISOString(), approvedBy.trim()],
  );
  const jobRef = r.rows[0]?.id;
  if (!jobRef) throw new Error("work order insert returned no row");
  return { job_ref: jobRef, approved_by: approvedBy.trim() };
}
