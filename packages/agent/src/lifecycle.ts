import type { Model } from '@strands-agents/sdk';

/**
 * Strands SDK 1.19.0 compatibility adapter:
 * The BedrockModel implementation maintains an internal AWS SDK BedrockRuntimeClient (`_client`),
 * but does not yet implement AsyncDisposable, Disposable, or a public close/destroy lifecycle method.
 *
 * To prevent idle HTTP keep-alive connections or event-loop handles from keeping the Node.js process
 * alive after agent execution finishes, this adapter safely inspects and disposes underlying client
 * resources if present.
 *
 * This shim is strictly isolated here so that private property access is not scattered across the codebase.
 */
export function destroyModelResources(model: Model | unknown): void {
  if (!model || typeof model !== 'object') {
    return;
  }

  // Check for public destroy/close if Strands adds it in future versions
  const publicCandidate = model as {
    destroy?: () => void;
    close?: () => void;
  };
  if (typeof publicCandidate.destroy === 'function') {
    try {
      publicCandidate.destroy();
      return;
    } catch {
      // Ignore destroy failure during teardown
    }
  }
  if (typeof publicCandidate.close === 'function') {
    try {
      publicCandidate.close();
      return;
    } catch {
      // Ignore close failure during teardown
    }
  }

  // Strands 1.19.0 BedrockModel internal client cleanup
  const internalCandidate = model as { _client?: { destroy?: () => void } };
  if (typeof internalCandidate._client?.destroy === 'function') {
    try {
      internalCandidate._client.destroy();
    } catch {
      // Ignore destroy failure during teardown
    }
  }
}
