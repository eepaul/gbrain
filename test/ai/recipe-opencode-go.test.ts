/**
 * opencode-go (Zen) recipe smoke (v0.41.31.0 wave).
 *
 * Mirrors the zhipu / together / openrouter recipe-test pattern. Covers:
 *  - registry registration with expected shape
 *  - chat-only touchpoint (no embedding — opencode-go is a chat fanout)
 *  - default auth: OPENCODE_GO_API_KEY → "Bearer <key>"; missing → AIConfigError
 *  - models list contains the probe winner (glm-5.1) and excludes the
 *    known-broken `qwen3.7-max` (not supported on opencode-go's oa-compat
 *    router — would surface as an HTTP-200 error envelope on every call)
 *  - probe-winner discoverability (setup_hint mentions glm-5.1)
 *  - supports_subagent_loop: false (informational; real Anthropic-direct
 *    gate is isAnthropicProvider() in src/core/model-config.ts)
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

describe('recipe: opencode-go', () => {
  test('registered with expected shape', () => {
    const r = getRecipe('opencode-go');
    expect(r).toBeDefined();
    expect(r!.id).toBe('opencode-go');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe('https://opencode.ai/zen/go/v1');
    expect(r!.auth_env?.required).toEqual(['OPENCODE_GO_API_KEY']);
  });

  test('chat touchpoint declared (no embedding — chat fanout only)', () => {
    const r = getRecipe('opencode-go')!;
    expect(r.touchpoints.chat).toBeDefined();
    expect(r.touchpoints.embedding).toBeUndefined();
    expect(r.touchpoints.reranker).toBeUndefined();
  });

  test('probe winner glm-5.1 is first in models list (discoverability)', () => {
    const r = getRecipe('opencode-go')!;
    expect(r.touchpoints.chat!.models[0]).toBe('glm-5.1');
  });

  test('models list includes head-to-head probed candidates', () => {
    const r = getRecipe('opencode-go')!;
    const models = r.touchpoints.chat!.models;
    expect(models).toContain('glm-5.1');
    expect(models).toContain('qwen3.6-plus');
    expect(models).toContain('deepseek-v4-flash');
    expect(models).toContain('kimi-k2.6');
  });

  test('models list EXCLUDES qwen3.7-max (known-broken on oa-compat router)', () => {
    // Probed 2026-05-31: passing qwen3.7-max through the oa-compat route
    // returns `{"type":"error","error":{"type":"ModelError","message":"Model
    // qwen3.7-max is not supported for format oa-compat"}}` on every call.
    // Surfaces as an HTTP-200 error envelope (not a recipe validator throw),
    // so silently exposing it would lose every gradeable claim on every page
    // it ran on. Pinned absent so a future model-catalog refresh that adds
    // it back without verifying the oa-compat route fails this test.
    const r = getRecipe('opencode-go')!;
    expect(r.touchpoints.chat!.models).not.toContain('qwen3.7-max');
  });

  test('supports_subagent_loop is false (informational only — real gate is isAnthropicProvider)', () => {
    const r = getRecipe('opencode-go')!;
    expect(r.touchpoints.chat!.supports_subagent_loop).toBe(false);
  });

  test('supports_tools is false (openai-compat tools envelope not verified on opencode-go)', () => {
    const r = getRecipe('opencode-go')!;
    expect(r.touchpoints.chat!.supports_tools).toBe(false);
  });

  test('default auth: OPENCODE_GO_API_KEY set → "Bearer <key>"', () => {
    const r = getRecipe('opencode-go')!;
    const auth = defaultResolveAuth(r, { OPENCODE_GO_API_KEY: 'sk-fake-opencode' }, 'chat');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer sk-fake-opencode');
  });

  test('default auth: missing OPENCODE_GO_API_KEY → AIConfigError', () => {
    const r = getRecipe('opencode-go')!;
    expect(() => defaultResolveAuth(r, {}, 'chat')).toThrow(AIConfigError);
  });

  test('setup_hint surfaces the probe winner (glm-5.1) for propose_takes', () => {
    const r = getRecipe('opencode-go')!;
    expect(r.setup_hint).toContain('opencode-go:glm-5.1');
    expect(r.setup_hint).toContain('propose_takes');
  });

  test('cost stamped 0 with verified date (probe response confirmed free tier 2026-05-31)', () => {
    const r = getRecipe('opencode-go')!;
    expect(r.touchpoints.chat!.cost_per_1m_input_usd).toBe(0);
    expect(r.touchpoints.chat!.cost_per_1m_output_usd).toBe(0);
    expect(r.touchpoints.chat!.price_last_verified).toBe('2026-05-31');
  });
});
