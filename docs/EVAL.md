# Evaluation

RAG quality here is **measured, not asserted.** A versioned ground-truth set is
run through the real pipeline and scored, so a change to chunking, the retrieval
threshold, or the prompt shows up as a number rather than a vibe.

## What's measured

Against a fixed demo corpus (a fictional coffee-subscription business,
`api/eval/corpus/`), the set has two kinds of question:

- **On-corpus (32)** — answerable from the docs. The assistant should answer,
  ground the answer in the right source, and get the facts right.
- **Off-corpus (11)** — genuinely not in the corpus (real-time, competitor,
  general knowledge, coding, medical, out-of-scope features, undisclosed). The
  assistant should **refuse**.

Each on-corpus case carries `expectedFacts` (key substrings a correct answer must
contain) and `expectedDocs` (the source doc(s) that ground it). Off-corpus cases
are chosen so the corpus offers no scope fact to answer from — a refusal is
unambiguously correct.

## Metrics

| Metric | Definition |
| --- | --- |
| **Answer accuracy** | on-corpus answers containing all `expectedFacts` / on-corpus total |
| **Citation accuracy** | on-corpus answers that cited an `expectedDoc` / on-corpus total |
| **Citation precision (answered)** | of the on-corpus questions actually answered, the fraction citing a correct doc |
| **False refusals** | on-corpus questions the assistant wrongly refused |
| **Refusal precision** | correctly-refused (off-corpus) / everything refused — "when it refused, should it have?" |
| **Refusal recall** | correctly-refused (off-corpus) / all off-corpus — "did it refuse everything it should?" |

Refusal is the positive class: a **false refusal** (refusing an answerable
question) hurts precision; a **missed refusal** (answering an off-corpus
question) hurts recall. Both are failure modes the guardrails exist to prevent.

Fact matching is a case-insensitive substring test with a **digit-boundary rule**
so a numeric fact can't spuriously match (`"$5"` does not match `"$50"`; `"2"`
does not match inside `"12 oz"`). Transport/generation errors are tracked
separately and **excluded** from the quality numbers — an infra blip must not
masquerade as a quality regression.

## How to reproduce

Needs `OPENAI_API_KEY` + `ANTHROPIC_API_KEY` in `.env` and local infra up:

```bash
npm run db:up
npm run eval -w @asab/api
```

The harness seeds a tenant, ingests `api/eval/corpus` through the **real**
pipeline (parse → chunk → embed → pgvector), runs every question through the
**real** chat route (retrieval → threshold gate → Claude generation →
citations), scores the results, prints a report, and writes
`api/eval/eval-report.json`. It's non-deterministic (a real LLM) — this is a
measurement, not a pass/fail proof — and cleans up the seeded tenant on exit.

The scoring/metric logic is a pure module with unit tests (`api/src/eval/`), so
CI validates the metric definitions without provider keys; the full run needs
keys, like every other live proof script.

An optional CI gate fails the run when quality drops below floors:

```bash
EVAL_GATE=1 EVAL_MIN_ANSWER=0.85 EVAL_MIN_REFUSAL_RECALL=0.9 npm run eval -w @asab/api
```

## Results

> **Populate from a keyed run.** The numbers below come straight from
> `api/eval/eval-report.json` after `npm run eval`. They are intentionally left
> as placeholders here rather than fabricated — run the harness (which needs real
> provider keys) to fill them in.

| Metric | Model | Result |
| --- | --- | --- |
| Answer accuracy | `claude-haiku-4-5` | _pending keyed run_ |
| Citation accuracy | `claude-haiku-4-5` | _pending keyed run_ |
| Refusal precision | `claude-haiku-4-5` | _pending keyed run_ |
| Refusal recall | `claude-haiku-4-5` | _pending keyed run_ |
| Errored (excluded) | — | _pending keyed run_ |

Tuning chunk size and the refusal threshold from these numbers is tracked as a
follow-up ([#41](https://github.com/ktul15/ai-support-agent-builder/issues/41)).
