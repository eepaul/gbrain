/**
 * propose_takes defaultExtractor wiring (v0.41.31.0).
 *
 * Pins the two latent-bug fixes from the v0.41.31.0 wave:
 *
 *  1. maxTokens: 2048 → 8192. Reasoning models (R1-style CoT, ubiquitous on
 *     the opencode-go endpoint and now widespread) consume the output budget
 *     on reasoning_content BEFORE emitting content. At 2048, the head-to-head
 *     probe (5 pages × 4 models on a real brain) found 2/5 pages returning
 *     empty content with finish_reason=length for `deepseek-v4-flash` on
 *     5-15K-char pages. 8192 covers reasoning + JSON proposals for 19K-char
 *     pages with every R1-style variant we benchmarked.
 *
 *  2. maxRetries: 0. The Vercel AI SDK retries 2x by default. When the
 *     provider is behind a proxy that ALSO retries, a single transient blip
 *     becomes 9 calls per page (SDK 3 attempts × proxy 3 attempts) — the
 *     root cause of the v0.41.30 propose_takes throw-storm. propose_takes
 *     already has a per-cycle circuit breaker (maxConsecutiveExtractorFailures,
 *     default 3); SDK auto-retry on top is pure amplification.
 *
 * Test seam: `__setChatTransportForTests` from `src/core/ai/gateway.ts`
 * intercepts the `chat()` call and records the ChatOpts the caller passed.
 * Production paths see `_chatTransport === null` and route normally.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  __setChatTransportForTests,
  configureGateway,
  resetGateway,
  type ChatOpts,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { defaultExtractor } from '../src/core/cycle/propose-takes.ts';

const STUB_CHAT_RESULT: ChatResult = {
  text: '[]', // empty proposals — parseExtractorOutput returns []
  blocks: [{ type: 'text', text: '[]' }],
  stopReason: 'end',
  usage: { input_tokens: 100, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
  model: 'opencode-go:glm-5.1',
  providerId: 'opencode-go',
};

describe('propose_takes defaultExtractor — v0.41.31.0 wiring', () => {
  let capturedOpts: ChatOpts | null = null;

  beforeEach(() => {
    capturedOpts = null;
    configureGateway({
      // Gateway needs SOME chat_model to be valid; ours never gets called
      // because the test transport intercepts.
      chat_model: 'anthropic:claude-sonnet-4-6',
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      expansion_model: 'anthropic:claude-haiku-4-5',
      env: { ANTHROPIC_API_KEY: 'stub', OPENAI_API_KEY: 'stub' },
    });
    __setChatTransportForTests(async (opts: ChatOpts): Promise<ChatResult> => {
      capturedOpts = opts;
      return STUB_CHAT_RESULT;
    });
  });

  afterEach(() => {
    __setChatTransportForTests(null);
    resetGateway();
  });

  test('passes maxTokens: 8192 to gateway (R1 reasoning budget)', async () => {
    await defaultExtractor({
      pagePath: 'note/x',
      pageBody: 'some prose',
      existingTakes: [],
    });
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.maxTokens).toBe(8192);
  });

  test('passes maxRetries: 0 to gateway (defeats SDK + proxy retry amplification)', async () => {
    await defaultExtractor({
      pagePath: 'note/x',
      pageBody: 'some prose',
      existingTakes: [],
    });
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.maxRetries).toBe(0);
  });

  test('threads modelHint through to gateway.chat({model})', async () => {
    await defaultExtractor({
      pagePath: 'note/x',
      pageBody: 'some prose',
      existingTakes: [],
      modelHint: 'opencode-go:glm-5.1',
    });
    expect(capturedOpts!.model).toBe('opencode-go:glm-5.1');
  });

  test('omits model field when modelHint is undefined (lets gateway default apply)', async () => {
    await defaultExtractor({
      pagePath: 'note/x',
      pageBody: 'some prose',
      existingTakes: [],
    });
    // No modelHint passed → conditional spread omits the field, gateway
    // falls back to cfg.chat_model.
    expect(capturedOpts!.model).toBeUndefined();
  });

  test('substitutes {EXISTING_TAKES_JSON} + {PAGE_BODY} placeholders in prompt', async () => {
    await defaultExtractor({
      pagePath: 'note/x',
      pageBody: 'PAGE_PROSE_MARKER_42',
      existingTakes: [{ claim: 'EXISTING_MARKER_99', kind: 'take', holder: 'brain', weight: 0.5 }],
    });
    const userMsg = capturedOpts!.messages[0];
    expect(userMsg.role).toBe('user');
    const content = typeof userMsg.content === 'string'
      ? userMsg.content
      : (userMsg.content as any[]).map((b: any) => b.text ?? '').join('');
    expect(content).toContain('PAGE_PROSE_MARKER_42');
    expect(content).toContain('EXISTING_MARKER_99');
    // The placeholders themselves must be GONE post-substitution.
    expect(content).not.toContain('{PAGE_BODY}');
    expect(content).not.toContain('{EXISTING_TAKES_JSON}');
  });
});
