-- Seed data. Every person, company, address, email and phone number here is fictional.
-- Emails use example.com; phone numbers use the Ofcom drama range (07700 900xxx);
-- the 'ZZ' postcode area does not exist.

INSERT INTO landlords (id, name, email) VALUES
  ('L01', 'Marian Thistlewood', 'marian.thistlewood@example.com'),
  ('L02', 'Corvin Albright',    'corvin.albright@example.com');

INSERT INTO properties (id, name, address_line, town, postcode, landlord_id) VALUES
  ('P-ASH', 'Ashgrove Court',     '12 Wrenfold Road', 'Larkhaven', 'ZZ1 4AB', 'L01'),
  ('P-BRM', 'Bramblewick House',  '3 Tillery Lane',   'Larkhaven', 'ZZ2 7CD', 'L01'),
  ('P-CIN', 'Cinderfield Mews',   '8 Orrin Street',   'Larkhaven', 'ZZ3 1EF', 'L02'),
  ('P-DUN', 'Dunmere Lofts',      '40 Quarry Bank',   'Larkhaven', 'ZZ4 9GH', 'L02');

INSERT INTO units (id, property_id, label, bedrooms) VALUES
  ('U-ASH-1', 'P-ASH', 'Flat 1', 1),
  ('U-ASH-2', 'P-ASH', 'Flat 2', 2),
  ('U-ASH-3', 'P-ASH', 'Flat 3', 2),
  ('U-ASH-4', 'P-ASH', 'Flat 4', 1),
  ('U-ASH-5', 'P-ASH', 'Flat 5', 3),
  ('U-ASH-6', 'P-ASH', 'Flat 6', 2),
  ('U-BRM-1', 'P-BRM', 'Flat 1', 1),
  ('U-BRM-2', 'P-BRM', 'Flat 2', 2),
  ('U-BRM-3', 'P-BRM', 'Flat 3', 2),
  ('U-BRM-4', 'P-BRM', 'Flat 4', 1),
  ('U-CIN-1', 'P-CIN', 'Flat 1', 2),
  ('U-CIN-2', 'P-CIN', 'Flat 2', 2),
  ('U-CIN-3', 'P-CIN', 'Flat 3', 3),
  ('U-DUN-1', 'P-DUN', 'Flat 1', 1),
  ('U-DUN-2', 'P-DUN', 'Flat 2', 1),
  ('U-DUN-3', 'P-DUN', 'Flat 3', 2);

INSERT INTO residents (id, full_name, email, phone, unit_id) VALUES
  ('R01', 'Priya Lindqvist',  'priya.l@example.com',            '07700 900101', 'U-ASH-1'),
  ('R02', 'Tomasz Okafor',    't.okafor@example.com',           '07700 900102', 'U-ASH-2'),
  ('R03', 'Hannah Brecken',   'hannah.brecken@example.com',     '07700 900103', 'U-ASH-3'),
  ('R04', 'Dev Marlowe',      'dev.marlowe@example.com',        '07700 900104', 'U-ASH-5'),
  ('R05', 'Aoife Castellane', 'aoife.c@example.com',            '07700 900105', 'U-BRM-1'),
  ('R06', 'Samuel Idris',     'sam.idris@example.com',          '07700 900106', 'U-BRM-2'),
  ('R07', 'Mei Halloran',     'mei.halloran@example.com',       '07700 900107', 'U-BRM-3'),
  ('R08', 'Kwame Ashdown',    'kwame.ashdown@example.com',      '07700 900108', 'U-BRM-4'),
  ('R09', 'Lena Faraday',     'lena.faraday@example.com',       '07700 900109', 'U-CIN-1'),
  ('R10', 'Oskar Penhallow',  'oskar.p@example.com',            '07700 900110', 'U-CIN-2'),
  ('R11', 'Grace Nwosu-Hale', 'grace.nh@example.com',           '07700 900111', 'U-CIN-3'),
  ('R12', 'Rafi Delacourt',   'rafi.d@example.com',             '07700 900112', 'U-DUN-1'),
  ('R13', 'Ines Moorcroft',   'ines.moorcroft@example.com',     '07700 900113', 'U-DUN-2'),
  ('R14', 'Callum Yarrow',    'callum.yarrow@example.com',      '07700 900114', 'U-DUN-3');

INSERT INTO leases (id, unit_id, resident_id, start_date, end_date, monthly_rent_pence, rent_due_day) VALUES
  ('LS-01', 'U-ASH-1', 'R01', '2025-09-01', '2026-08-31', 95000, 1),
  ('LS-02', 'U-ASH-2', 'R02', '2026-02-01', '2027-01-31', 125000, 1),
  ('LS-03', 'U-ASH-3', 'R03', '2026-04-01', '2027-03-31', 120000, 1),
  ('LS-04', 'U-ASH-5', 'R04', '2026-06-01', '2027-05-31', 165000, 1),
  ('LS-05', 'U-BRM-1', 'R05', '2026-01-01', '2026-12-31', 115000, 1),
  ('LS-06', 'U-BRM-2', 'R06', '2026-03-01', '2027-02-28', 130000, 1),
  ('LS-07', 'U-BRM-3', 'R07', '2026-05-01', '2027-04-30', 128000, 1),
  ('LS-08', 'U-BRM-4', 'R08', '2026-07-01', '2027-06-30', 105000, 1),
  ('LS-09', 'U-CIN-1', 'R09', '2026-02-15', '2027-02-14', 135000, 15),
  ('LS-10', 'U-CIN-2', 'R10', '2025-12-01', '2026-11-30', 132000, 1),
  ('LS-11', 'U-CIN-3', 'R11', '2026-01-10', '2027-01-09', 175000, 10),
  ('LS-12', 'U-DUN-1', 'R12', '2026-08-01', '2027-07-31', 98000, 1),
  ('LS-13', 'U-DUN-2', 'R13', '2026-09-01', '2027-08-31', 99000, 1),
  ('LS-14', 'U-DUN-3', 'R14', '2026-02-01', '2027-01-31', 118000, 1);

-- November is paid for everyone except LS-06 (arrears). December is due, unpaid.
INSERT INTO rent_ledger (lease_id, due_date, amount_pence, paid_pence, paid_on)
SELECT id,
       make_date(2026, 11, rent_due_day),
       monthly_rent_pence,
       CASE WHEN id = 'LS-06' THEN 0 ELSE monthly_rent_pence END,
       CASE WHEN id = 'LS-06' THEN NULL ELSE make_date(2026, 11, rent_due_day) END
FROM leases;

INSERT INTO rent_ledger (lease_id, due_date, amount_pence, paid_pence, paid_on)
SELECT id, make_date(2026, 12, rent_due_day), monthly_rent_pence, 0, NULL
FROM leases;

INSERT INTO contractors (id, name, trade, phone) VALUES
  ('C01', 'Kestrelford Plumbing & Heating', 'plumbing',   '07700 900201'),
  ('C02', 'Ampleby Electrical',             'electrical', '07700 900202'),
  ('C03', 'Larkhaven Lock & Key',           'locksmith',  '07700 900203'),
  ('C04', 'Mossdale Damp Solutions',        'damp',       '07700 900204'),
  ('C05', 'Greywick General Maintenance',   'general',    '07700 900205');

INSERT INTO work_orders (id, unit_id, category, description, status, priority, contractor_id, scheduled_for, created_at) VALUES
  ('WO-0990', 'U-ASH-1', 'heating',    'Annual boiler service',           'completed', 'P4', 'C01', '2026-10-02 09:00:00+00', '2026-09-20 11:00:00+00'),
  ('WO-1001', 'U-ASH-2', 'plumbing',   'Kitchen tap dripping constantly', 'scheduled', 'P3', 'C01', '2026-11-19 10:00:00+00', '2026-11-12 08:40:00+00'),
  ('WO-1002', 'U-BRM-3', 'ventilation','Bathroom extractor fan not working','open',    'P3', NULL,  NULL,                     '2026-10-27 15:10:00+00'),
  ('WO-1003', 'U-CIN-2', 'security',   'Front door lock sticking',        'scheduled', 'P2', 'C03', '2026-11-20 14:00:00+00', '2026-11-14 09:05:00+00'),
  ('WO-1004', 'U-DUN-1', 'damp',       'Mould on bedroom wall',           'scheduled', 'P3', 'C04', '2026-11-24 09:30:00+00', '2026-11-10 13:20:00+00'),
  ('WO-1005', 'U-ASH-6', 'general',    'Loose handrail in hallway',       'open',      'P3', 'C05', NULL,                     '2026-11-16 10:00:00+00');

-- Seeded jobs end at WO-1005, so the next approved work order is WO-1006.
SELECT setval('work_order_ref_seq', 1005);
