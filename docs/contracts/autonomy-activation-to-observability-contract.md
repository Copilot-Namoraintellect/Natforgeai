# Autonomy activation → observability

Version: `autonomy-observability/v1`. Producer: R10-H. Consumer: R10-E/X.
Read-only projection: `controller.observer.observe(exactScope)`.
No HTTP or model mutation tool is registered in this stream.

| Field | Meaning |
|---|---|
| scope | tenantId, businessId, capability, actionClass, verified before reading |
| configuredLevel / effectiveLevel | maximum policy level / present reduced level |
| runtimeState | separate operational state vocabulary |
| downgradeReason | closed safety/administration reason |
| safeMode | true in SAFE_MODE |
| suspension | kind + bounded reference or null |
| canaryScope | provider, percentage, absolute volume ceiling, time window; enclosing scope remains exact |
| killSwitch | local latch OR independently read emergency stop |
| lastAuthorityChange | UTC change timestamp |
| authoritySource | independent admin source or RUNTIME_SAFETY/UNCONFIGURED |
| policyVersion / version | adopted policy and current CAS version |
| actualExecution | always false; projection is never an execution outcome |

Absent configuration reports DISABLED, UNCONFIGURED, version 0; missing health
is not synthesized as healthy. Unavailable independent kill reader fails visibly.
The projection uses a non-writing repository read. It exposes no policy editor,
action parameters, approval material, provider credentials, secrets, thoughts or
history mutation. Consumers must preserve shadow labels and never count a
shadow result or canary reservation as actual execution.

R10-E remains read-only observation authority. It may report health facts and
recommend action; trusted H composition evaluates those facts and may only
reduce authority automatically. Monitoring may not call administration, resume
work, expand canary, alter policy, clear kill switch or silence backup alerts.
R10-A/X binds collection, availability, rapid independent stop, worker drain and
scheduler controls. No infrastructure integration is activated here.
