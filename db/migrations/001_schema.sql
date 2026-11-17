-- Schema for the property-management triage agent.
-- All data is fictional. Runs on PostgreSQL (here: PGlite, Postgres compiled to WASM).

CREATE TABLE landlords (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  email       text NOT NULL UNIQUE
);

CREATE TABLE properties (
  id            text PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  address_line  text NOT NULL,
  town          text NOT NULL,
  postcode      text NOT NULL,
  landlord_id   text NOT NULL REFERENCES landlords(id)
);

CREATE TABLE units (
  id           text PRIMARY KEY,
  property_id  text NOT NULL REFERENCES properties(id),
  label        text NOT NULL,           -- e.g. 'Flat 3'
  bedrooms     integer NOT NULL CHECK (bedrooms >= 0),
  UNIQUE (property_id, label)
);

CREATE TABLE residents (
  id         text PRIMARY KEY,
  full_name  text NOT NULL,
  email      text NOT NULL UNIQUE,
  phone      text NOT NULL,
  unit_id    text NOT NULL REFERENCES units(id)
);

CREATE TABLE leases (
  id                  text PRIMARY KEY,
  unit_id             text NOT NULL REFERENCES units(id),
  resident_id         text NOT NULL REFERENCES residents(id),
  start_date          date NOT NULL,
  end_date            date NOT NULL,
  monthly_rent_pence  integer NOT NULL CHECK (monthly_rent_pence > 0),
  rent_due_day        integer NOT NULL CHECK (rent_due_day BETWEEN 1 AND 28),
  CHECK (end_date > start_date)
);

CREATE TABLE rent_ledger (
  id           serial PRIMARY KEY,
  lease_id     text NOT NULL REFERENCES leases(id),
  due_date     date NOT NULL,
  amount_pence integer NOT NULL CHECK (amount_pence > 0),
  paid_pence   integer NOT NULL DEFAULT 0 CHECK (paid_pence >= 0),
  paid_on      date,
  UNIQUE (lease_id, due_date)
);

CREATE TABLE contractors (
  id     text PRIMARY KEY,
  name   text NOT NULL,
  trade  text NOT NULL,
  phone  text NOT NULL
);

CREATE TABLE work_orders (
  id             text PRIMARY KEY,
  unit_id        text NOT NULL REFERENCES units(id),
  category       text NOT NULL,
  description    text NOT NULL,
  status         text NOT NULL CHECK (status IN ('open', 'scheduled', 'completed', 'cancelled')),
  priority       text NOT NULL CHECK (priority IN ('P1', 'P2', 'P3', 'P4')),
  contractor_id  text REFERENCES contractors(id),
  scheduled_for  timestamptz,
  created_at     timestamptz NOT NULL,
  approved_by    text,
  CHECK (status <> 'scheduled' OR scheduled_for IS NOT NULL)
);

-- Job references ('WO-1006', ...) are allocated from a sequence, never from max(id) + 1.
CREATE SEQUENCE work_order_ref_seq START WITH 1001;

CREATE INDEX work_orders_unit_status_idx ON work_orders (unit_id, status);
CREATE INDEX leases_unit_idx ON leases (unit_id, start_date DESC);
-- Senders are looked up by lower(email), so uniqueness and the index are on lower(email) too.
CREATE UNIQUE INDEX residents_email_lower_idx ON residents (lower(email));
CREATE UNIQUE INDEX landlords_email_lower_idx ON landlords (lower(email));
