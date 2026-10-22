import type { EvidenceRef } from '@clientops/contracts';
import type { ToolExecutionTrace } from './schemas.js';

export function sanitizeToolArguments(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {};
  }

  const sanitized: Record<string, unknown> = {};
  const forbiddenPatterns = [
    'secret',
    'key',
    'token',
    'password',
    'credential',
    'auth',
  ];

  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    const isSensitive = forbiddenPatterns.some((pattern) =>
      key.toLowerCase().includes(pattern),
    );
    if (isSensitive) {
      sanitized[key] = '[REDACTED]';
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      sanitized[key] = value;
    } else if (typeof value === 'object') {
      sanitized[key] = sanitizeToolArguments(value);
    } else {
      sanitized[key] = String(value);
    }
  }

  return sanitized;
}

export class RequestExecutionTracker {
  private traces: ToolExecutionTrace[] = [];
  private activeCalls = new Map<
    string,
    {
      toolName: string;
      startTime: number;
      sanitizedArgs: Record<string, unknown>;
    }
  >();

  public onBeforeCall(
    callId: string,
    toolName: string,
    rawArgs: unknown,
  ): void {
    const sanitizedArgs = sanitizeToolArguments(rawArgs);
    this.activeCalls.set(callId, {
      toolName,
      startTime: Date.now(),
      sanitizedArgs,
    });
  }

  public onAfterCall(
    callId: string,
    toolName: string,
    evidenceReferences: EvidenceRef[],
    isError = false,
    errorMessage?: string,
  ): ToolExecutionTrace {
    const call = this.activeCalls.get(callId);
    const durationMs = call ? Date.now() - call.startTime : 0;
    const sanitizedArgs = call ? call.sanitizedArgs : {};

    const trace: ToolExecutionTrace = {
      toolName,
      arguments: sanitizedArgs,
      durationMs,
      status: isError ? 'error' : 'ok',
      evidenceReferences,
      ...(errorMessage ? { errorMessage } : {}),
    };

    this.traces.push(trace);
    this.activeCalls.delete(callId);
    return trace;
  }

  public getTraces(): ToolExecutionTrace[] {
    return [...this.traces];
  }
}
