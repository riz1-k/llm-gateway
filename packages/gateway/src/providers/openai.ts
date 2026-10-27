import type { OpenAIProviderConfig } from '../config/schema.js';
import type { ResolvedModel } from '../config/resolve.js';
import { ProviderError } from '../core/errors.js';
import type { RerankRequest, RerankResponse } from '../core/types.js';
import type { AdapterDeps, AttemptContext } from './base.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';

/**
 * Native OpenAI adapter (api.openai.com or any Azure-style compatible base URL). Same wire
 * format as `openai-compatible`, plus organization/project headers; OpenAI has no rerank API.
 */
export class OpenAIAdapter extends OpenAICompatibleAdapter {
  override readonly type: string = 'openai';
  private readonly openaiConfig: OpenAIProviderConfig;

  constructor(name: string, config: OpenAIProviderConfig, deps: AdapterDeps) {
    super(name, config, deps);
    this.openaiConfig = config;
  }

  protected override buildHeaders(): Record<string, string> {
    const headers = super.buildHeaders();
    if (this.openaiConfig.organization)
      headers['openai-organization'] = this.openaiConfig.organization;
    if (this.openaiConfig.project) headers['openai-project'] = this.openaiConfig.project;
    return headers;
  }

  override async rerank(
    _req: RerankRequest,
    target: ResolvedModel,
    _ctx: AttemptContext,
  ): Promise<RerankResponse> {
    throw new ProviderError({
      status: 400,
      code: 'invalid_request',
      message: `${this.name}: the OpenAI API has no rerank endpoint (model ${target.name})`,
      provider: this.name,
      retryable: false,
      fallback: true,
      countsAsFailure: false,
    });
  }
}
