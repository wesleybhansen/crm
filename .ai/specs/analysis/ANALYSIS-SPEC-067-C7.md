# Pre-Implementation Analysis: SPEC-067 C7 bounded Strategist context

## Executive summary

The Strategist was count-bounded to 24 history rows and six model iterations, but message JSON, per-message text, cumulative history bytes, and total tool calls remained unbounded. CRM also loaded a thread's full history before Hub selected recent turns. C7 adds deterministic byte/count ceilings at both repositories. It does not summarize with another model, change the selected model, widen tool rights, or create an external effect.

## Compatibility and safety audit

| Surface | Impact | Treatment |
|---|---|---|
| CRM chat persistence | Rejects chat JSON above 64 KiB | Enforced by both route validation and the store service |
| CRM message read | Returns the latest bounded window in chronological order | Default/maximum 200 rows; Hub requests its smaller model-history window |
| Strategist history | Bounds row, per-row, and cumulative characters | Most recent turns win; original durable rows remain unchanged |
| Tool loop | Caps result text and total tool calls per turn | Excess calls receive an explicit non-executing limit event |
| Model/output | Keeps Gemini 3.5 Flash and six iterations | Final stored answer is capped; no new summarization call or spend |
| Schema | No change | C7 is source/test/spec only |

## Acceptance plan

1. Prove oversized and non-serializable direct-store content fails before persistence.
2. Prove bounded reads select the newest rows and preserve chronological display order.
3. Prove the model receives no more than the documented cumulative history and tool-result limits.
4. Prove a model-requested tool burst cannot exceed the per-turn execution ceiling.
5. Re-run CRM/Noli module, TypeScript, lint, production-build, and diff gates with all external-effect flags off.

## Recommendation

Proceed. Deterministic bounding materially reduces storage, latency, and token-cost risk without sacrificing durable history or introducing another model call.
