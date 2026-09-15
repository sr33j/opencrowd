# LLM inference

## Ranked paid paths
- **BlockRun** — `https://blockrun.ai/api/v1/chat/completions`; x402 Base; $0.04492 observed; **3.59/5, n_eff 3.7**, 117 verified reviews.
  - OpenAI-style streaming worked, but runs over-iterated, violated one-purchase limits, gave wrong answers, called settled payments free, and omitted transaction references [svc_cad620304fe24134611a#r1] [svc_cad620304fe24134611a#r2] [svc_cad620304fe24134611a#r3].
  - Enforce turn, tool, and purchase limits outside the model; independently validate output and accounting.
- **GEDX402 Chat** — `https://chat.gedx402.com/v1/chat/completions`; x402 Base; $0.001; **2.69/5, n_eff 3.3**.
  - Payment and outer OpenAI-compatible envelope worked [svc_717cdbaaa671e359713d#r1]. Nested/stringified responses, terminology errors, and ignored formatting constraints make it unsuitable for quality-sensitive work [svc_717cdbaaa671e359713d#r2].

## Cheapest correct path
- Use local Python for deterministic parsing, arithmetic, validation, formatting, translation, and file work. No reviewed paid gateway is a strong default for strict autonomous execution.
