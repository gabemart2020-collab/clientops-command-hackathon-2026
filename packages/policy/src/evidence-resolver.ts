import type { EvidenceRef, ModelEvidenceCitation } from '@clientops/contracts';

/**
 * Error thrown when a proposal cites an entity or field that cannot be resolved
 * against the request-local authoritative evidence registry.
 */
export class ProposalEvidenceResolutionError extends Error {
  constructor(
    public readonly citation: ModelEvidenceCitation,
    message: string,
  ) {
    super(
      `Evidence resolution failed for citation (${citation.entityType}:${citation.entityId}${citation.field ? `.${citation.field}` : ''}): ${message}`,
    );
    this.name = 'ProposalEvidenceResolutionError';
  }
}

/**
 * Authoritative evidence resolver interface.
 * Implemented by request-local evidence registries (e.g. EvidenceRegistry).
 */
export interface AuthoritativeEvidenceResolver {
  resolveCitation(citation: ModelEvidenceCitation): {
    success: boolean;
    resolved?: EvidenceRef | undefined;
    error?: string | undefined;
  };
}

/**
 * Resolves untrusted model citation pointers into canonical, server-hydrated EvidenceRef records.
 *
 * Requirements:
 * - The model emits citation pointers only: entityType, entityId, optional field.
 * - Proposal registration resolves these from the request-local authoritative evidence registry.
 * - Unknown, fabricated, wrong-field, or ambiguous citations reject proposal registration immediately.
 * - Persists ONLY canonical server-hydrated EvidenceRef records.
 */
export function resolveProposalEvidence(
  citations: readonly ModelEvidenceCitation[],
  registry: AuthoritativeEvidenceResolver,
): EvidenceRef[] {
  if (!citations || citations.length === 0) {
    throw new Error(
      'Proposal evidence resolution failed: at least one citation is required for proposal registration.',
    );
  }

  const hydratedEvidence: EvidenceRef[] = [];

  for (const citation of citations) {
    const result = registry.resolveCitation(citation);

    if (!result.success || !result.resolved) {
      throw new ProposalEvidenceResolutionError(
        citation,
        result.error ??
          'Unknown, fabricated, wrong-field, or ambiguous citation.',
      );
    }

    hydratedEvidence.push({
      entityType: result.resolved.entityType,
      entityId: result.resolved.entityId,
      ...(result.resolved.field ? { field: result.resolved.field } : {}),
      ...(result.resolved.excerpt ? { excerpt: result.resolved.excerpt } : {}),
    });
  }

  return hydratedEvidence;
}
