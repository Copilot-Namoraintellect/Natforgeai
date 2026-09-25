// ─── PublishPackage → AuthoritativePublicationInput mapping (WBS13 seam) ───
//
// One thin, pure mapping between the two accepted WBS13 foundations: the
// immutable PublishPackage (WBS13.1) and the governed platform adapter input
// (WBS13.3). This is the only place where a package crosses into the adapter
// boundary, so the seam stays narrow:
//
//   - the package payload is the semantic source of truth; the content is
//     projected verbatim via the already-accepted publishPackageToAdapterPayload
//     (no copy is ever reconstructed from mutable rows here);
//   - the operation identity is derived with the accepted adapter identity
//     utility (derivePublicationOperationId) from the publishing-queue item id,
//     so retries of the same queue item keep one publication identity;
//   - no validation is duplicated — package integrity, queue binding,
//     freshness, and destination authority stay with the publishing runner
//     and the existing contract/builder guards.

import {
  derivePublicationOperationId,
  type AuthoritativePublicationInput,
} from "../integrations/adapters/platform-adapter";
import {
  publishPackageToAdapterPayload,
  type PublishPackage,
} from "./publish-package-builder";

/**
 * Translate an already-authoritative immutable publish package into the
 * governed adapter input for one publishing-queue item. `queueItemId` anchors
 * the operation identity: the same queue item always maps to the same
 * operationId, so a retry never becomes a semantic regeneration.
 */
export function publishPackageToAuthoritativeInput(
  pkg: PublishPackage,
  queueItemId: number | string
): AuthoritativePublicationInput {
  const platform = pkg.identity.destination.platform;
  return {
    operationId: derivePublicationOperationId({ platform, queueItemId }),
    content: publishPackageToAdapterPayload(pkg),
  };
}
