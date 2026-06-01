import type { Recipe } from '../types.ts';

/**
 * opencode-go (https://opencode.ai/zen/go/v1) — single-key fan-out to a
 * curated set of Chinese open-weights frontier models (GLM, DeepSeek, Qwen,
 * Kimi, MiniMax, MiMo, Hunyuan) via an OpenAI-compatible endpoint.
 *
 * Use case: cheap / free per-task model routing for jobs where Anthropic
 * subagent loops are NOT needed (e.g. `propose_takes` extractor — long-prompt
 * + strict-JSON-array output, single-shot, no tools, no Anthropic-direct
 * tool_use_id stability gate). The v0.41.31.0 wave shipped this recipe
 * specifically because the propose_takes head-to-head probe (5 pages × 4
 * models on a real brain) found:
 *
 *   model              | parse_ok | med_lat  | avg_proposals
 *   glm-5.1            |  5/5     |  12.8s   | 5.4   ← winner
 *   qwen3.6-plus       |  5/5     |  68.9s   | 3.0   ← stable fallback
 *   deepseek-v4-flash  |  3/5     |  48.8s   | 3.0   ← reasoning blow-up
 *   kimi-k2.6          |  2/5     |  66.6s   | 2.0   ← long-tail 503
 *
 * `deepseek-v4-flash` and `kimi-k2.6` are reasoning models that exhaust the
 * 8192-token output budget on `reasoning_content` for 5-15K-char pages,
 * returning empty `content` (`finish_reason=length`). `glm-5.1` either
 * doesn't expose reasoning or stays compact (median 1641 completion tokens)
 * — that's what propose_takes wants for strict-JSON extraction.
 *
 * Recipe shape parity with `together.ts` / `zhipu.ts` (chat-only). No
 * embedding touchpoint — opencode-go is a chat-completion fanout.
 *
 * Subagent loops: `supports_subagent_loop: false` is informational. The real
 * gate is `isAnthropicProvider()` in `src/core/model-config.ts` which
 * hard-pins gbrain's subagent infra to Anthropic-direct (stable tool_use_id
 * across crashes/replays). opencode-go is rejected at submit time regardless
 * of this flag.
 *
 * NOTE: `qwen3.7-max` appears in opencode-go's `/v1/models` listing but
 * returns `"Model qwen3.7-max is not supported for format oa-compat"` on
 * the `/v1/chat/completions` endpoint as of 2026-05-31 — only available via
 * opencode's native (non-OpenAI-compat) route. It is intentionally OMITTED
 * from the models list below; passing it through this recipe would surface
 * as an HTTP-200 error envelope rather than a clean validator rejection.
 */
export const opencodeGo: Recipe = {
  id: 'opencode-go',
  name: 'opencode-go (Zen)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://opencode.ai/zen/go/v1',
  auth_env: {
    required: ['OPENCODE_GO_API_KEY'],
    setup_url: 'https://opencode.ai/',
  },
  touchpoints: {
    chat: {
      // Curated list verified against opencode.ai/zen/go/v1/models on
      // 2026-05-31. `qwen3.7-max` omitted (native-only route — see header).
      // The openai-compat tier does NOT enforce this list at runtime; users
      // can pass any model ID opencode-go's router accepts. Refresh
      // quarterly; pin via the recipe test file at
      // `test/ai/recipe-opencode-go.test.ts`.
      models: [
        // Probe winner — strict-JSON extraction at 12.8s median, 5.4 proposals/page
        'glm-5.1',
        'glm-5',
        // Probe stable fallback — 100% parse_ok but slower
        'qwen3.6-plus',
        'qwen3.5-plus',
        // Probe non-winners (reasoning blow-up / long-tail 503) — kept for
        // user override but NOT recommended for strict-JSON extraction
        'deepseek-v4-pro',
        'deepseek-v4-flash',
        'kimi-k2.6',
        'kimi-k2.5',
        // Non-reasoning models (probe smoke confirmed direct-answer shape) —
        // not yet head-to-head benchmarked on propose_takes; may be worth
        // a separate probe wave for strict-JSON workloads.
        'minimax-m2.7',
        'minimax-m2.5',
        'mimo-v2-pro',
        'mimo-v2-omni',
        'mimo-v2.5-pro',
        'mimo-v2.5',
        'hy3-preview',
      ],
      supports_tools: false, // openai-compat tools envelope NOT verified
      // Informational only — real gate is isAnthropicProvider() upstream.
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      // No max_context_tokens: catalog spans 128K to 256K; one recipe-wide
      // value is either unsafe for smaller models or wasteful for larger
      // ones. Let upstream errors surface per-model.
      // Pricing: opencode-go's chat-completions response stamps `cost: "0"`
      // on the free tier as of 2026-05-31. Treat as zero-cost-for-now; the
      // budget tracker's free-provider recognition (see
      // `src/core/budget/budget-tracker.ts:FREE_LOCAL_RERANK_PROVIDERS` for
      // the rerank precedent) is not yet extended to chat.
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-05-31',
    },
  },
  setup_hint:
    'Get an API key at https://opencode.ai/, then `export OPENCODE_GO_API_KEY=...` or `gbrain config set opencode_go_api_key <key>` (file-plane). Use `opencode-go:<model>` strings, e.g. `opencode-go:glm-5.1` (recommended for `propose_takes`).',
};
