# prompt-compressor-service — Release Notes

LLMLingua-2 / stopword sidecar. Compresses verbose prompt layers
(CLAUDE.md / RUNTIME_EVIDENCE) before they hit the LLM. Default
strategy is zero-ML stopword removal (~0 ms latency); LLMLingua-2 BERT
base stays available behind an opt-in build arg + env switch.

## API surface

| Method | Path                            | Notes                                                                |
|--------|---------------------------------|----------------------------------------------------------------------|
| GET    | `/health`                       | Liveness + current strategy/model.                                   |
| GET    | `/healthz/strict`               | 503 only when LLMLingua strategy is selected AND model load failed.  |
| POST   | `/api/v1/compress`              | Compress one text. Body: `{text, target_token?, rate?, instruction?, question?, force_tokens?, metadata?}`. |
| GET    | `/api/v1/status`                | Operator-facing diagnostic. Reports loaded?, lazy_load, min/max thresholds, strategy. |

## Env vars

| Var                                | Default                                                     | Notes                                                                  |
|------------------------------------|-------------------------------------------------------------|------------------------------------------------------------------------|
| `COMPRESSION_ENABLED`              | `true`                                                      | When false, `/api/v1/compress` returns 409 COMPRESSION_DISABLED.        |
| `COMPRESSION_STRATEGY`             | `stopwords`                                                 | One of `stopwords` (default) or `llmlingua`. `llmlingua` requires the model to be baked into the image. |
| `COMPRESSION_MODEL_NAME`           | `microsoft/llmlingua-2-bert-base-multilingual-…-meetingbank` | LLMLingua HF model id when strategy=llmlingua.                          |
| `COMPRESSION_DEVICE`               | `cpu`                                                       | Build is for CPU; flip requires a different image.                     |
| `COMPRESSION_LAZY_LOAD`            | `true`                                                      | When false, pre-warm the model at startup so the first call is fast.   |
| `COMPRESSION_MIN_TARGET_TOKENS`    | `20`                                                        | Reject target_token below this.                                        |
| `COMPRESSION_MAX_INPUT_CHARS`      | `200000`                                                    | Reject input larger than this (413).                                   |

## Dependencies

**Upstream consumers**:
- prompt-composer (M62 Slice D) — per-layer compression when
  `ComposeInput.compression.enabled=true`.

**Downstream**:
- None at runtime. Model weights are baked into the image at build
  time (`COMPRESSION_BAKE_MODEL` build-arg). `TRANSFORMERS_OFFLINE=1`
  set in the runtime container so no outbound network is required.

## Milestones

- **M62 Slice A** — service skeleton + Dockerfile. Lazy-load singleton. CPU torch wheel + transformers + LLMLingua optional install.
- **M62 Slice B** — `/api/v1/compress` endpoint. Validation + structured 4xx errors + receipt_id for audit correlation. 11 pytest cases.
- **M62 Slice C** — image built + smoke-tested with the live container.
- **M62 Slice F** — stopwords strategy added and made default. Dockerfile gained `COMPRESSION_BAKE_MODEL=skip` default so the lean (~200MB) build skips torch + transformers entirely. LLMLingua remains opt-in for operators who pay the 30+ min first build + 600MB resident memory cost.

## Known limitations

- LLMLingua-2 BERT base model needs ~600MB resident memory. The container limit is 2G — enough headroom for the model + tokenizer + per-call buffers. For LLMLingua-2 BERT large, bump the compose limit to 3G.
- Stopword strategy is lossy. Output stays human-readable but the model loses connective tissue. For prompts where exact phrasing matters (legal text, code snippets), skip the compressor or set the per-layer budget high enough that the layer doesn't trigger compression.
- `target_token` is ADVISORY in the stopwords strategy — the deterministic drop pass can't hit an arbitrary target. The response carries a warning when the actual count overshoots by >50%, with a hint to flip to `COMPRESSION_STRATEGY=llmlingua`.
- `force_tokens` is honored in both strategies (case-sensitive whole-word match in stopwords; pinned-token semantics in LLMLingua).
