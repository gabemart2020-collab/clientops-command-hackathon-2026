import {
  EvidenceEntityTypeSchema,
  EvidenceRefSchema,
  type EvidenceRef,
  type AgentBrief,
} from '@clientops/contracts';
import type { GroundingValidationResult } from './schemas.js';

export function makeEvidenceKey(entityType: string, entityId: string): string {
  return `${entityType.toLowerCase()}:${entityId.toLowerCase()}`;
}

export function normalizeFieldName(
  field: string | undefined,
): string | undefined {
  if (!field) {
    return undefined;
  }
  return field
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .trim();
}

export function normalizeExcerptText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019'"`“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface AuthoritativeFacts {
  accounts: Map<string, { id: string; name?: string | undefined }>;
  meetings: Map<
    string,
    { id: string; title?: string | undefined; scheduledAt?: string | undefined }
  >;
  deliveryHealths: Set<string>;
}

export interface AuthoritativeEvidenceEntry {
  ref: EvidenceRef;
  isPrimary: boolean;
}

export interface CitationResolutionResult {
  success: boolean;
  resolved?: EvidenceRef;
  error?: string;
  unsupportedReference?: EvidenceRef;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class GroundingValidator {
  private authoritativeEvidence = new Map<
    string,
    AuthoritativeEvidenceEntry[]
  >();
  private allAuthoritativeEvidence: EvidenceRef[] = [];
  private facts: AuthoritativeFacts = {
    accounts: new Map(),
    meetings: new Map(),
    deliveryHealths: new Set(),
  };

  public registerEvidence(ref: EvidenceRef, isPrimary = false): void {
    const key = makeEvidenceKey(ref.entityType, ref.entityId);
    const existing = this.authoritativeEvidence.get(key) ?? [];
    const normField = normalizeFieldName(ref.field);
    const isDuplicate = existing.some(
      (e) =>
        normalizeFieldName(e.ref.field) === normField &&
        (e.ref.excerpt ?? '') === (ref.excerpt ?? ''),
    );
    if (!isDuplicate) {
      existing.push({ ref, isPrimary });
      this.authoritativeEvidence.set(key, existing);
      this.allAuthoritativeEvidence.push(ref);
    } else if (isPrimary) {
      const match = existing.find(
        (e) =>
          normalizeFieldName(e.ref.field) === normField &&
          (e.ref.excerpt ?? '') === (ref.excerpt ?? ''),
      );
      if (match) {
        match.isPrimary = true;
      }
    }
  }

  public registerEvidenceList(refs: EvidenceRef[], isPrimary = false): void {
    for (const ref of refs) {
      this.registerEvidence(ref, isPrimary);
    }
  }

  public registerAuthoritativeAccount(account: {
    id: string;
    name?: string | undefined;
  }): void {
    this.facts.accounts.set(account.id.toLowerCase(), account);
    if (account.name) {
      this.registerEvidence(
        {
          entityType: 'client',
          entityId: account.id,
          field: 'name',
          excerpt: account.name,
        },
        false,
      );
    }
  }

  public registerAuthoritativeMeeting(meeting: {
    id: string;
    title?: string | undefined;
    scheduledAt?: string | undefined;
  }): void {
    this.facts.meetings.set(meeting.id.toLowerCase(), meeting);
    if (meeting.title) {
      this.registerEvidence(
        {
          entityType: 'meeting',
          entityId: meeting.id,
          field: 'title',
          excerpt: meeting.title,
        },
        false,
      );
    }
    if (meeting.scheduledAt) {
      this.registerEvidence(
        {
          entityType: 'meeting',
          entityId: meeting.id,
          field: 'scheduled_at',
          excerpt: meeting.scheduledAt,
        },
        false,
      );
    }
  }

  public registerAuthoritativeHealth(health: string): void {
    this.facts.deliveryHealths.add(health.toLowerCase());
  }

  /**
   * Recursively inspects tool outputs to extract authoritative evidence references
   * and identifiable domain entities.
   */
  public extractAndRegisterFromToolOutput(
    _toolName: string,
    output: unknown,
  ): EvidenceRef[] {
    const extracted: EvidenceRef[] = [];

    const traverse = (node: unknown): void => {
      if (!node || typeof node !== 'object') {
        return;
      }

      if (Array.isArray(node)) {
        for (const item of node) {
          traverse(item);
        }
        return;
      }

      const obj = node as Record<string, unknown>;

      // 1. Direct EvidenceRef
      const directRef = EvidenceRefSchema.safeParse(obj);
      if (directRef.success) {
        extracted.push(directRef.data);
        const isPrimary =
          directRef.data.field !== 'status' &&
          directRef.data.field !== 'resolved_at';
        this.registerEvidence(directRef.data, isPrimary);
      }

      // 2. Nested .evidence property (array or single object)
      if (obj.evidence && typeof obj.evidence === 'object') {
        if (Array.isArray(obj.evidence)) {
          for (const ev of obj.evidence) {
            const nestedRef = EvidenceRefSchema.safeParse(ev);
            if (nestedRef.success) {
              extracted.push(nestedRef.data);
              const isPrimary =
                nestedRef.data.field !== 'status' &&
                nestedRef.data.field !== 'resolved_at';
              this.registerEvidence(nestedRef.data, isPrimary);
            }
          }
        } else {
          const nestedRef = EvidenceRefSchema.safeParse(obj.evidence);
          if (nestedRef.success) {
            extracted.push(nestedRef.data);
            const isPrimary =
              nestedRef.data.field !== 'status' &&
              nestedRef.data.field !== 'resolved_at';
            this.registerEvidence(nestedRef.data, isPrimary);
          }
        }
      }

      // 3. Nested .evidenceRef property
      if (obj.evidenceRef && typeof obj.evidenceRef === 'object') {
        const nestedRef = EvidenceRefSchema.safeParse(obj.evidenceRef);
        if (nestedRef.success) {
          extracted.push(nestedRef.data);
          this.registerEvidence(nestedRef.data, true);

          // If this object is an ActivityItem (has title and summary), register them for the underlying entity
          if (typeof obj.title === 'string' && obj.title.trim().length > 0) {
            const titleRef: EvidenceRef = {
              entityType: nestedRef.data.entityType,
              entityId: nestedRef.data.entityId,
              field: 'title',
              excerpt: obj.title.trim(),
            };
            extracted.push(titleRef);
            this.registerEvidence(titleRef, false);

            if (nestedRef.data.entityType === 'communication') {
              const subjectRef: EvidenceRef = {
                entityType: nestedRef.data.entityType,
                entityId: nestedRef.data.entityId,
                field: 'subject',
                excerpt: obj.title.trim(),
              };
              extracted.push(subjectRef);
              this.registerEvidence(subjectRef, false);
            }
          }

          if (
            typeof obj.summary === 'string' &&
            obj.summary.trim().length > 0
          ) {
            const summaryRef: EvidenceRef = {
              entityType: nestedRef.data.entityType,
              entityId: nestedRef.data.entityId,
              field: 'summary',
              excerpt: obj.summary.trim(),
            };
            extracted.push(summaryRef);
            this.registerEvidence(summaryRef, false);

            if (nestedRef.data.entityType === 'decision') {
              const rationaleRef: EvidenceRef = {
                entityType: nestedRef.data.entityType,
                entityId: nestedRef.data.entityId,
                field: 'rationale',
                excerpt: obj.summary.trim(),
              };
              extracted.push(rationaleRef);
              this.registerEvidence(rationaleRef, false);
            }
          }
        }
      }

      // 3.5. Nested .originatingEvidence property
      if (
        obj.originatingEvidence &&
        typeof obj.originatingEvidence === 'object'
      ) {
        const nestedRef = EvidenceRefSchema.safeParse(obj.originatingEvidence);
        if (nestedRef.success) {
          extracted.push(nestedRef.data);
          this.registerEvidence(nestedRef.data, true);
        }
      }

      // 4. Structured business facts: delivery health
      if (typeof obj.health === 'string') {
        this.registerAuthoritativeHealth(obj.health);
      }
      if (typeof obj.deliveryHealth === 'string') {
        this.registerAuthoritativeHealth(obj.deliveryHealth);
      }

      // 5. Domain entities with id and recognizable types
      if (typeof obj.id === 'string' && UUID_REGEX.test(obj.id)) {
        let inferredType: string | null = null;
        if (
          ('tier' in obj && 'industry' in obj) ||
          ('status' in obj && 'tier' in obj) ||
          ('name' in obj && 'slug' in obj)
        ) {
          inferredType = 'client';
          const clientName =
            typeof obj.name === 'string' ? obj.name : undefined;
          this.registerAuthoritativeAccount({
            id: obj.id,
            name: clientName,
          });
        } else if (
          ('scheduledAt' in obj || 'scheduled_at' in obj) &&
          'title' in obj
        ) {
          inferredType = 'meeting';
          const title = typeof obj.title === 'string' ? obj.title : undefined;
          const scheduledAt =
            typeof obj.scheduledAt === 'string'
              ? obj.scheduledAt
              : typeof obj.scheduled_at === 'string'
                ? obj.scheduled_at
                : undefined;
          this.registerAuthoritativeMeeting({
            id: obj.id,
            title,
            scheduledAt,
          });
        } else if (
          ('dueAt' in obj || 'due_at' in obj) &&
          ('assignee' in obj || 'description' in obj || 'owner' in obj)
        ) {
          inferredType = 'commitment';
        } else if (
          'channel' in obj ||
          'requiresResponse' in obj ||
          'requires_response' in obj
        ) {
          inferredType = 'communication';
        } else if (
          'targetDate' in obj ||
          'target_date' in obj ||
          (('dueAt' in obj || 'due_at' in obj) && 'projectId' in obj)
        ) {
          inferredType = 'milestone';
        } else if (
          'projectId' in obj &&
          'status' in obj &&
          'title' in obj &&
          !('dueAt' in obj || 'due_at' in obj)
        ) {
          inferredType = 'task';
        } else if (
          'decidedAt' in obj ||
          'decided_at' in obj ||
          'rationale' in obj
        ) {
          inferredType = 'decision';
        } else if (
          ('clientId' in obj &&
            ('health' in obj ||
              'deliveryHealth' in obj ||
              'leadUserId' in obj)) ||
          'targetCompletionAt' in obj ||
          'target_completion_at' in obj ||
          'leadUserId' in obj ||
          ('name' in obj &&
            'status' in obj &&
            !('slug' in obj) &&
            !('tier' in obj) &&
            !('channel' in obj) &&
            !('dueAt' in obj) &&
            !('due_at' in obj) &&
            !('title' in obj))
        ) {
          inferredType = 'project';
        }

        if (inferredType) {
          const typeParsed = EvidenceEntityTypeSchema.safeParse(inferredType);
          if (typeParsed.success) {
            const entType = typeParsed.data;
            const regField = (
              fieldName: string,
              val: unknown,
              isPrimary = false,
            ) => {
              if (typeof val === 'string' && val.trim().length > 0) {
                const ref: EvidenceRef = {
                  entityType: entType,
                  entityId: obj.id as string,
                  field: normalizeFieldName(fieldName),
                  excerpt: val.trim(),
                };
                extracted.push(ref);
                this.registerEvidence(ref, isPrimary);
              }
            };

            // Register specific scalar fields
            if ('title' in obj)
              regField(
                'title',
                obj.title,
                entType === 'meeting' || entType === 'task',
              );
            if ('name' in obj)
              regField(
                'name',
                obj.name,
                entType === 'client' || entType === 'project',
              );
            if ('description' in obj)
              regField(
                'description',
                obj.description,
                entType === 'commitment',
              );
            if ('summary' in obj) regField('summary', obj.summary, false);
            if ('rationale' in obj) regField('rationale', obj.rationale, false);
            if ('subject' in obj) regField('subject', obj.subject, false);
            if ('status' in obj) regField('status', obj.status, false);
            if ('channel' in obj) regField('channel', obj.channel, false);
            if ('health' in obj) regField('health', obj.health, false);
            if ('dueAt' in obj) regField('due_at', obj.dueAt, false);
            if ('due_at' in obj) regField('due_at', obj.due_at, false);
            if ('scheduledAt' in obj)
              regField('scheduled_at', obj.scheduledAt, false);
            if ('scheduled_at' in obj)
              regField('scheduled_at', obj.scheduled_at, false);
            if ('completedAt' in obj)
              regField('completed_at', obj.completedAt, false);
            if ('completed_at' in obj)
              regField('completed_at', obj.completed_at, false);
          }
        }
      }

      // Project reference from health assessment outputs: { projectId: "...", health: "..." }
      if (typeof obj.projectId === 'string' && UUID_REGEX.test(obj.projectId)) {
        if (typeof obj.health === 'string' && obj.health.trim().length > 0) {
          const ref: EvidenceRef = {
            entityType: 'project',
            entityId: obj.projectId,
            field: 'health',
            excerpt: obj.health.trim(),
          };
          extracted.push(ref);
          this.registerEvidence(ref, false);
        }
        if (
          typeof obj.deliveryHealth === 'string' &&
          obj.deliveryHealth.trim().length > 0
        ) {
          const ref: EvidenceRef = {
            entityType: 'project',
            entityId: obj.projectId,
            field: 'health',
            excerpt: obj.deliveryHealth.trim(),
          };
          extracted.push(ref);
          this.registerEvidence(ref, false);
        }
      }

      for (const value of Object.values(obj)) {
        traverse(value);
      }
    };

    traverse(output);
    return extracted;
  }

  public getAuthoritativeCount(): number {
    return this.allAuthoritativeEvidence.length;
  }

  public getAuthoritativeEvidence(): EvidenceRef[] {
    return [...this.allAuthoritativeEvidence];
  }

  /**
   * Resolves a model evidence citation into an authoritative EvidenceRef from the request-local registry.
   * Discards any model-authored excerpt, fails closed on unknown or ambiguous citations,
   * and copies the authoritative source excerpt.
   */
  public resolveCitation(citation: EvidenceRef): CitationResolutionResult {
    const key = makeEvidenceKey(citation.entityType, citation.entityId);
    const candidates = this.authoritativeEvidence.get(key);

    if (!candidates || candidates.length === 0) {
      return {
        success: false,
        error: `Unsupported entity ID: ${citation.entityType} ${citation.entityId}`,
        unsupportedReference: citation,
      };
    }

    const normField = normalizeFieldName(citation.field);
    const cleanCitExcerpt = citation.excerpt
      ? normalizeExcerptText(citation.excerpt)
      : undefined;

    if (normField) {
      const fieldMatches = candidates.filter(
        (c) => normalizeFieldName(c.ref.field) === normField,
      );

      if (fieldMatches.length === 0) {
        return {
          success: false,
          error: `Field mismatch for ${citation.entityType} ${citation.entityId}: "${citation.field}" is not in authoritative evidence`,
          unsupportedReference: citation,
        };
      }

      // If citation provided an excerpt, verify excerpt containment: cleanAuth.includes(cleanCit)
      if (cleanCitExcerpt && cleanCitExcerpt.length > 0) {
        const excerptMatches = fieldMatches.filter((c) => {
          const cleanAuth = normalizeExcerptText(c.ref.excerpt ?? '');
          return cleanAuth.includes(cleanCitExcerpt);
        });

        if (excerptMatches.length === 0) {
          return {
            success: false,
            error: `Fabricated excerpt for ${citation.entityType} ${citation.entityId}: "${citation.excerpt}"`,
            unsupportedReference: citation,
          };
        }

        if (excerptMatches.length === 1) {
          return {
            success: true,
            resolved: { ...excerptMatches[0]!.ref },
          };
        }

        const primary = excerptMatches.filter((c) => c.isPrimary);
        if (primary.length === 1) {
          return {
            success: true,
            resolved: { ...primary[0]!.ref },
          };
        }
      }

      if (fieldMatches.length === 1) {
        return {
          success: true,
          resolved: { ...fieldMatches[0]!.ref },
        };
      }

      const primaryMatches = fieldMatches.filter((c) => c.isPrimary);
      if (primaryMatches.length === 1) {
        return {
          success: true,
          resolved: { ...primaryMatches[0]!.ref },
        };
      }

      const uniqueExcerpts = new Set(
        fieldMatches.map((c) => c.ref.excerpt ?? ''),
      );
      if (uniqueExcerpts.size === 1) {
        return {
          success: true,
          resolved: { ...fieldMatches[0]!.ref },
        };
      }

      return {
        success: false,
        error: `Ambiguous citation for ${citation.entityType} ${citation.entityId}: multiple distinct evidence references exist for field "${citation.field}"`,
        unsupportedReference: citation,
      };
    }

    // No field specified in citation
    if (cleanCitExcerpt && cleanCitExcerpt.length > 0) {
      const excerptMatches = candidates.filter((c) => {
        const cleanAuth = normalizeExcerptText(c.ref.excerpt ?? '');
        return cleanAuth.includes(cleanCitExcerpt);
      });

      if (excerptMatches.length === 1) {
        return {
          success: true,
          resolved: { ...excerptMatches[0]!.ref },
        };
      }

      if (excerptMatches.length === 0) {
        return {
          success: false,
          error: `Fabricated excerpt for ${citation.entityType} ${citation.entityId}: "${citation.excerpt}"`,
          unsupportedReference: citation,
        };
      }

      const primary = excerptMatches.filter((c) => c.isPrimary);
      if (primary.length === 1) {
        return {
          success: true,
          resolved: { ...primary[0]!.ref },
        };
      }

      const withField = excerptMatches.filter((c) => c.ref.field !== undefined);
      const candidatesToUse = withField.length > 0 ? withField : excerptMatches;
      const uniqueExcerpts = new Set(
        candidatesToUse.map((c) => normalizeExcerptText(c.ref.excerpt ?? '')),
      );
      const uniqueFields = new Set(
        candidatesToUse.map((c) => normalizeFieldName(c.ref.field)),
      );
      if (uniqueExcerpts.size === 1 && uniqueFields.size === 1) {
        return {
          success: true,
          resolved: { ...candidatesToUse[0]!.ref },
        };
      }

      return {
        success: false,
        error: `Ambiguous citation for ${citation.entityType} ${citation.entityId}: multiple evidence references match excerpt "${citation.excerpt}"`,
        unsupportedReference: citation,
      };
    }

    // No field and no excerpt: exactly 1 candidate or unique primary candidate required
    if (candidates.length === 1) {
      return {
        success: true,
        resolved: { ...candidates[0]!.ref },
      };
    }

    const primaryCandidates = candidates.filter((c) => c.isPrimary);
    if (primaryCandidates.length === 1) {
      return {
        success: true,
        resolved: { ...primaryCandidates[0]!.ref },
      };
    }

    return {
      success: false,
      error: `Ambiguous citation for ${citation.entityType} ${citation.entityId}: entity has multiple authoritative evidence entries and no field was specified`,
      unsupportedReference: citation,
    };
  }

  /**
   * Resolves model evidence citations into canonical authoritative EvidenceRef structures
   * and validates complete grounding and structured facts.
   */
  public resolveAndHydrateBrief(brief: AgentBrief): {
    brief: AgentBrief;
    grounding: GroundingValidationResult;
  } {
    let groundedEvidenceCount = 0;
    let unsupportedEvidenceCount = 0;
    const unsupportedReferences: EvidenceRef[] = [];
    const unsupportedReasons: string[] = [];

    const isRefusal = brief.mode === 'capability_refusal';

    // 1. Validate capability refusal or findings presence
    if (isRefusal) {
      const refusalText =
        `${brief.answer} ${brief.refusalReason ?? ''}`.toLowerCase();
      const hasRefusalStatement =
        refusalText.includes('not executed') ||
        refusalText.includes('cannot create') ||
        refusalText.includes('cannot execute') ||
        refusalText.includes('cannot perform') ||
        refusalText.includes('cannot modify') ||
        refusalText.includes('read-only') ||
        refusalText.includes('refuse') ||
        refusalText.includes('not supported') ||
        refusalText.includes('no write');
      if (!hasRefusalStatement) {
        unsupportedEvidenceCount++;
        unsupportedReasons.push(
          'Capability refusal must explicitly state that the requested action was not executed.',
        );
      }
    } else {
      if (!brief.findings || brief.findings.length === 0) {
        unsupportedEvidenceCount++;
        unsupportedReasons.push('Agent brief contains zero findings.');
      }
    }

    // 2. Resolve findings citations into canonical authoritative EvidenceRefs
    const hydratedFindings = (brief.findings ?? []).map((finding) => {
      const hydratedEvidence: EvidenceRef[] = [];

      if (!finding.evidence || finding.evidence.length === 0) {
        unsupportedEvidenceCount++;
        unsupportedReasons.push(
          `Finding "${finding.statement.slice(0, 50)}" has no evidence.`,
        );
      } else {
        for (const citation of finding.evidence) {
          const res = this.resolveCitation(citation);
          if (res.success && res.resolved) {
            groundedEvidenceCount++;
            hydratedEvidence.push(res.resolved);
          } else {
            unsupportedEvidenceCount++;
            unsupportedReferences.push(res.unsupportedReference ?? citation);
            if (res.error) {
              unsupportedReasons.push(res.error);
            }
          }
        }
      }

      return {
        ...finding,
        evidence:
          hydratedEvidence.length > 0 ? hydratedEvidence : finding.evidence,
      };
    });

    // 3. Validate structured account (requires authoritative account fact)
    if (brief.account) {
      if (!brief.account.id || !brief.account.name) {
        unsupportedEvidenceCount++;
        unsupportedReasons.push(
          'Emitted account must specify both id and name.',
        );
      } else {
        const authAccount = this.facts.accounts.get(
          brief.account.id.toLowerCase(),
        );

        if (!authAccount) {
          unsupportedEvidenceCount++;
          unsupportedReferences.push({
            entityType: 'client',
            entityId: brief.account.id,
            excerpt: brief.account.name,
          });
          unsupportedReasons.push(
            `Account ID ${brief.account.id} was not observed as an authoritative account fact in tool output.`,
          );
        } else if (
          !authAccount.name ||
          authAccount.name.trim().toLowerCase() !==
            brief.account.name.trim().toLowerCase()
        ) {
          unsupportedEvidenceCount++;
          unsupportedReferences.push({
            entityType: 'client',
            entityId: brief.account.id,
            field: 'name',
            excerpt: brief.account.name,
          });
          unsupportedReasons.push(
            `Account name mismatch for ${brief.account.id}: expected "${authAccount.name}", got "${brief.account.name}".`,
          );
        }
      }
    }

    // 4. Validate structured meeting (requires authoritative meeting fact)
    if (brief.meeting) {
      if (
        !brief.meeting.id ||
        !brief.meeting.title ||
        !brief.meeting.scheduledAt
      ) {
        unsupportedEvidenceCount++;
        unsupportedReasons.push(
          'Emitted meeting must specify id, title, and scheduledAt.',
        );
      } else {
        const authMeeting = this.facts.meetings.get(
          brief.meeting.id.toLowerCase(),
        );

        if (!authMeeting) {
          unsupportedEvidenceCount++;
          unsupportedReferences.push({
            entityType: 'meeting',
            entityId: brief.meeting.id,
            excerpt: brief.meeting.title,
          });
          unsupportedReasons.push(
            `Meeting ID ${brief.meeting.id} was not observed as an authoritative meeting fact in tool output.`,
          );
        } else {
          if (
            !authMeeting.title ||
            authMeeting.title.trim().toLowerCase() !==
              brief.meeting.title.trim().toLowerCase()
          ) {
            unsupportedEvidenceCount++;
            unsupportedReferences.push({
              entityType: 'meeting',
              entityId: brief.meeting.id,
              field: 'title',
              excerpt: brief.meeting.title,
            });
            unsupportedReasons.push(
              `Meeting title mismatch for ${brief.meeting.id}: expected "${authMeeting.title}", got "${brief.meeting.title}".`,
            );
          }
          const authTime = authMeeting.scheduledAt
            ? new Date(authMeeting.scheduledAt).getTime()
            : NaN;
          const briefTime = brief.meeting.scheduledAt
            ? new Date(brief.meeting.scheduledAt).getTime()
            : NaN;
          const isTimeMatch =
            !isNaN(authTime) && !isNaN(briefTime)
              ? authTime === briefTime
              : authMeeting.scheduledAt?.trim() ===
                brief.meeting.scheduledAt.trim();
          if (!isTimeMatch) {
            unsupportedEvidenceCount++;
            unsupportedReferences.push({
              entityType: 'meeting',
              entityId: brief.meeting.id,
              field: 'scheduledAt',
              excerpt: brief.meeting.scheduledAt,
            });
            unsupportedReasons.push(
              `Meeting scheduledAt mismatch for ${brief.meeting.id}: expected "${authMeeting.scheduledAt}", got "${brief.meeting.scheduledAt}".`,
            );
          }
        }
      }
    }

    // 5. Validate structured delivery health (requires authoritative health fact)
    if (brief.health) {
      if (this.facts.deliveryHealths.size === 0) {
        unsupportedEvidenceCount++;
        unsupportedReasons.push(
          `Health "${brief.health}" was emitted without observing an authoritative health-producing tool.`,
        );
      } else if (!this.facts.deliveryHealths.has(brief.health.toLowerCase())) {
        unsupportedEvidenceCount++;
        unsupportedReasons.push(
          `Health mismatch: model generated "${brief.health}" but authoritative health is ${Array.from(this.facts.deliveryHealths).join(', ')}.`,
        );
      }
    }

    const valid = isRefusal
      ? unsupportedEvidenceCount === 0
      : unsupportedEvidenceCount === 0 && groundedEvidenceCount > 0;

    let message: string | undefined;
    if (!valid) {
      message =
        unsupportedReasons.length > 0
          ? `Grounding validation failed: ${unsupportedReasons.join('; ')}`
          : `Grounding validation failed: ${unsupportedEvidenceCount} unsupported evidence reference(s) found.`;
    }

    const grounding: GroundingValidationResult = {
      valid,
      groundedEvidenceCount,
      unsupportedEvidenceCount,
      authoritativeEvidenceCount: this.allAuthoritativeEvidence.length,
      unsupportedReferences,
      ...(message ? { message } : {}),
    };

    return {
      brief: {
        ...brief,
        account: brief.account ?? undefined,
        meeting: brief.meeting ?? undefined,
        health: brief.health ?? undefined,
        findings: hydratedFindings,
      },
      grounding,
    };
  }

  public validateBrief(brief: AgentBrief): GroundingValidationResult {
    return this.resolveAndHydrateBrief(brief).grounding;
  }
}
