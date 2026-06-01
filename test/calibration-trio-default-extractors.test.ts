/**
 * Calibration trio defaultJudge / defaultPatternsGenerator /
 * defaultBiasTagsGenerator / voice-gate defaultJudge — v0.41.31.0 wiring.
 *
 * Pins the maxRetries: 0 posture across all 4 calibration LLM call sites.
 * Companion to test/propose-takes-default-extractor.test.ts (which covers
 * propose_takes specifically) — together they enforce the bug-class
 * uniformity decision: every calibration-trio gatewayChat call defeats
 * SDK + proxy retry amplification.
 *
 * Test seam: __setChatTransportForTests intercepts gateway.chat() and
 * records the ChatOpts the caller passed. Production paths see
 * _chatTransport === null and route normally.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  __setChatTransportForTests,
  configureGateway,
  resetGateway,
  type ChatOpts,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { defaultJudge as defaultGradeJudge } from '../src/core/cycle/grade-takes.ts';
import {
  defaultPatternsGenerator,
  defaultBiasTagsGenerator,
} from '../src/core/cycle/calibration-profile.ts';
import { defaultJudge as defaultVoiceGateJudge } from '../src/core/calibration/voice-gate.ts';

const STUB_GRADE_RESULT: ChatResult = {
  text: JSON.stringify({ verdict: 'correct', confidence: 0.9, reasoning: 'stub' }),
  blocks: [{ type: 'text', text: '' }],
  stopReason: 'end',
  usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 },
  model: 'anthropic:claude-sonnet-4-6',
  providerId: 'anthropic',
};

const STUB_PATTERNS_RESULT: ChatResult = {
  text: 'Your X tends to Y.\nWatch out for Z.',
  blocks: [{ type: 'text', text: '' }],
  stopReason: 'end',
  usage: { input_tokens: 100, output_tokens: 15, cache_read_tokens: 0, cache_creation_tokens: 0 },
  model: 'anthropic:claude-sonnet-4-6',
  providerId: 'anthropic',
};

const STUB_VOICE_RESULT: ChatResult = {
  text: JSON.stringify({ verdict: 'conversational', reason: 'sounds friendly' }),
  blocks: [{ type: 'text', text: '' }],
  stopReason: 'end',
  usage: { input_tokens: 80, output_tokens: 15, cache_read_tokens: 0, cache_creation_tokens: 0 },
  model: 'anthropic:claude-haiku-4-5',
  providerId: 'anthropic',
};

describe('calibration trio defaults — v0.41.31.0 maxRetries / modelHint wiring', () => {
  let capturedOpts: ChatOpts | null = null;
  let stubResult: ChatResult = STUB_GRADE_RESULT;

  beforeEach(() => {
    capturedOpts = null;
    stubResult = STUB_GRADE_RESULT;
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      expansion_model: 'anthropic:claude-haiku-4-5',
      env: { ANTHROPIC_API_KEY: 'stub', OPENAI_API_KEY: 'stub' },
    });
    __setChatTransportForTests(async (opts: ChatOpts): Promise<ChatResult> => {
      capturedOpts = opts;
      return stubResult;
    });
  });

  afterEach(() => {
    __setChatTransportForTests(null);
    resetGateway();
  });

  describe('grade_takes defaultJudge', () => {
    // Minimal Take shape — the full Take type has 16+ fields the
    // defaultJudge prompt doesn't read. `as any` is honest about the
    // test surface: we only care about prompt placeholder substitution
    // + ChatOpts shape, not Take field projection.
    const minimalTake = {
      id: 1, claim: 't', kind: 'take', holder: 'brain',
      weight: 0.6, since_date: '2026-01-01',
    } as any;

    test('passes maxRetries: 0 + maxTokens: 600', async () => {
      await defaultGradeJudge({ take: minimalTake, evidence: 'some evidence' });
      expect(capturedOpts).not.toBeNull();
      expect(capturedOpts!.maxRetries).toBe(0);
      expect(capturedOpts!.maxTokens).toBe(600);
    });

    test('threads modelHint to gateway.chat({model})', async () => {
      await defaultGradeJudge({
        take: minimalTake,
        evidence: 'some evidence',
        modelHint: 'opencode-go:glm-5.1',
      });
      expect(capturedOpts!.model).toBe('opencode-go:glm-5.1');
    });

    test('omits model when modelHint undefined (gateway default applies)', async () => {
      await defaultGradeJudge({ take: minimalTake, evidence: 'some evidence' });
      expect(capturedOpts!.model).toBeUndefined();
    });
  });

  describe('calibration_profile defaultPatternsGenerator', () => {
    beforeEach(() => {
      stubResult = STUB_PATTERNS_RESULT;
    });

    test('passes maxRetries: 0 + maxTokens: 500', async () => {
      await defaultPatternsGenerator({
        holder: 'garry',
        scorecard: { resolved: 5, correct: 3, incorrect: 1, partial: 1, brier: 0.3, accuracy: 0.6, partial_rate: 0.2 } as any,
        attempt: 0,
      });
      expect(capturedOpts).not.toBeNull();
      expect(capturedOpts!.maxRetries).toBe(0);
      expect(capturedOpts!.maxTokens).toBe(500);
    });

    test('threads modelHint to gateway.chat({model})', async () => {
      await defaultPatternsGenerator({
        holder: 'garry',
        scorecard: { resolved: 5, correct: 3, incorrect: 1, partial: 1, brier: 0.3, accuracy: 0.6, partial_rate: 0.2 } as any,
        attempt: 0,
        modelHint: 'opencode-go:glm-5.1',
      });
      expect(capturedOpts!.model).toBe('opencode-go:glm-5.1');
    });
  });

  describe('calibration_profile defaultBiasTagsGenerator', () => {
    beforeEach(() => {
      stubResult = {
        ...STUB_PATTERNS_RESULT,
        text: 'overconfident\nrecency-biased',
      };
    });

    test('passes maxRetries: 0 + maxTokens: 200', async () => {
      await defaultBiasTagsGenerator(['Your forecasts tend to miss the mark.']);
      expect(capturedOpts).not.toBeNull();
      expect(capturedOpts!.maxRetries).toBe(0);
      expect(capturedOpts!.maxTokens).toBe(200);
    });

    test('bias-tags deliberately does NOT accept modelHint (uses cfg.chat_model)', async () => {
      await defaultBiasTagsGenerator(['Your forecasts tend to miss the mark.']);
      // bias-tags generator signature is `(patterns: string[])` — no
      // modelHint slot. Pinning this so a future refactor either adds
      // the field explicitly (with intent) or this test breaks loud.
      expect(capturedOpts!.model).toBeUndefined();
    });

    test('short-circuits on empty patterns (no gateway call)', async () => {
      const out = await defaultBiasTagsGenerator([]);
      expect(out).toEqual([]);
      expect(capturedOpts).toBeNull();
    });
  });

  describe('voice-gate defaultJudge', () => {
    beforeEach(() => {
      stubResult = STUB_VOICE_RESULT;
    });

    test('passes maxRetries: 0 + maxTokens: 100', async () => {
      await defaultVoiceGateJudge({
        candidate: 'You tend to miss your high-conviction takes.',
        mode: 'pattern_statement',
        rubric: 'short and friendly',
      });
      expect(capturedOpts).not.toBeNull();
      expect(capturedOpts!.maxRetries).toBe(0);
      expect(capturedOpts!.maxTokens).toBe(100);
    });

    test('hardcoded to claude-haiku-4-5 (does not accept modelHint)', async () => {
      await defaultVoiceGateJudge({
        candidate: 'You tend to miss your high-conviction takes.',
        mode: 'pattern_statement',
        rubric: 'short and friendly',
      });
      // Voice gate is deliberately Haiku-only: it's a fast small-prompt
      // judge over user-facing text quality, and the calibration design
      // pinned it to a stable known-good voice. Pinning this so a future
      // refactor that adds modelHint here is a deliberate decision, not
      // a silent drift.
      expect(capturedOpts!.model).toBe('claude-haiku-4-5');
    });
  });
});
