-- PROVISIONAL R10-H artifact. DO NOT EXECUTE. R10-X owns convergence.
-- Runtime identity: SELECT/INSERT canary; SELECT activation; no audit UPDATE/DELETE.
-- Trusted administration writes state + INSERT audit in one transaction.
CREATE TABLE autonomy_activations (
  scope_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  version BIGINT UNSIGNED NOT NULL,
  state_json JSON NOT NULL
);
CREATE TABLE autonomy_activation_audit (
  scope_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version BIGINT UNSIGNED NOT NULL,
  audit_json JSON NOT NULL,
  PRIMARY KEY (scope_key, version)
);
CREATE TABLE autonomy_canary_reservations (
  scope_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action_id VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (scope_key, action_id)
);
