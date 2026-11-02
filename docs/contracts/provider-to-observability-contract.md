# Provider to observability contract

Version: `provider-health/v1`; producer R10-D, consumer R10-E.

The frozen allowlist is exported as PROVIDER_HEALTH_PROJECTION_KEYS:
contractVersion, tenantUserId, businessId, providerId, providerAccountId,
availabilityBps, latencyMsAvg, timeoutRateBps, rateLimitedCount,
authenticationFailureCount, callbackLagMsAvg, reconciliationBacklog,
circuitState, sampleCount, windowMs, healthDisclaimer, truthDisclaimer.

The producer must load samples under the authenticated tenant, business and
exact provider/account scope and apply the declared observation window before
calling the pure builder. No route or global unscoped query is added here.
The builder caps dispatch samples at 500. Consumers must retain the scope fields
and both disclaimer strings. No raw payload, credentials, exception message,
callback signature or model reasoning appears.

Undeclared signals are null. Empty samples do not imply availability or success.
Availability is the observed success fraction, not a guarantee of future
provider uptime. Missing circuit state is null. All rates use integer basis
points. Callback lag is nonnegative.

Provider health != provider-switch authority. This projection grants no
dispatch, retry, fallback, account/provider switching, credential administration,
governance decision or business-truth authority. R10-E can display and alert on
it; execution/recovery authority must still come from its existing owners.
