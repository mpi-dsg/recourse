-- Reproducible fixture for the Postgres workload.
-- Loaded against the integration Postgres at RECOURSE_PG_URL.
-- Schema and row contents are deterministic so seed_hash is stable.

DROP TABLE IF EXISTS tenant_rows;
CREATE TABLE tenant_rows (
  id INT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  value TEXT NOT NULL
);

INSERT INTO tenant_rows (id, tenant_id, value) VALUES
  (1, 'tenant-a', 'a1'),
  (2, 'tenant-a', 'a2'),
  (3, 'tenant-a', 'a3'),
  (4, 'tenant-b', 'b1'),
  (5, 'tenant-b', 'b2'),
  (6, 'tenant-c', 'c1');

DROP TABLE IF EXISTS recourse_fixture_metadata;
CREATE TABLE recourse_fixture_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO recourse_fixture_metadata (key, value) VALUES
  ('seed_hash', 'sha256:postgres-fixture-v1'),
  ('schema_version', '1'),
  ('row_count', '6');
