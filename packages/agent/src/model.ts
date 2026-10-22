import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { BedrockModel, type Model } from '@strands-agents/sdk';
import type { AgentRuntimeConfig } from './config.js';

export function createClientOpsModel(config: AgentRuntimeConfig): Model {
  return new BedrockModel({
    modelId: config.bedrockModelId,
    region: config.awsRegion,
    temperature: config.temperature,
    maxTokens: config.maxOutputTokens,
  });
}

/**
 * Checks whether valid AWS credentials can be resolved via the standard Node.js
 * AWS SDK credential provider chain (environment variables, AWS SSO, credentials/config files,
 * ECS/EC2 instance metadata).
 *
 * Strictly uses the AWS SDK v3 credential provider chain without initiating Bedrock model inference,
 * streaming, or consuming tokens.
 */
export async function resolveAwsCredentials(
  _modelId: string = 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
  _region: string = process.env.AWS_REGION ?? 'us-east-1',
): Promise<{ available: boolean; error?: string }> {
  void _modelId;
  void _region;
  try {
    const provider = defaultProvider();
    const credentials = await provider();

    if (!credentials || !credentials.accessKeyId) {
      return {
        available: false,
        error: 'Could not load valid AWS credentials (missing access key ID).',
      };
    }

    return { available: true };
  } catch (err: unknown) {
    const errText = (err as Error).message || String(err);
    const errName = (err as Error).name || '';

    // If credentials could not be loaded from standard providers:
    if (
      errName === 'CredentialsProviderError' ||
      errText.includes('Could not load credentials') ||
      errText.includes('credentials')
    ) {
      return {
        available: false,
        error:
          'Could not load credentials from any standard AWS providers (environment, profile, SSO, web identity, process, or container/instance metadata).',
      };
    }

    // If credential authentication failed on AWS side:
    if (
      errName === 'UnrecognizedClientException' ||
      errName === 'AccessDeniedException' ||
      errText.includes('security token') ||
      errText.includes('SignatureDoesNotMatch')
    ) {
      return {
        available: false,
        error: `AWS credential authentication failed: ${errName || errText}`,
      };
    }

    return {
      available: false,
      error: `AWS credential check failed: ${errText}`,
    };
  }
}
