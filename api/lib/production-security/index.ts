/**
 * R10-F — Production security primitives (F5).
 *
 * Barrel for the least-privilege secret machinery: classification (F2),
 * shape detection, cross-surface redaction, the model-payload guard and the
 * secret broker. See docs/contracts/production-security-configuration-contract.md.
 */

export * from "./secret-shapes";
export * from "./secret-classification";
export * from "./redact";
export * from "./payload-guard";
export * from "./secret-broker";
