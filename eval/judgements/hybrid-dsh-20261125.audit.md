# Hybrid Run Audit Notes

This is a manual review of the most important automated-label and citation
failures. It is not a replacement for labelling all 60 answers by hand.

## Known Incorrect Or Incomplete Answers

- `m01`: answered the plugin entry point but one-shot retrieval did not surface
  the automatic-cleanup chunk.
- `m07`: answered fixed-size cache but did not retrieve the cache-offloading
  evidence.
- `m09`: answered iterative generation but did not retrieve the crop evidence.
- `m11`: answered lexical retrieval but did not retrieve the vector-index
  evidence.

These four failures support the hypothesis that a single first subquery is not
enough for every multi-hop question.

## Citation Problems

- `s31`: the model wrote `[1#L7-L9]`, `[3#L11-L46]`, and `[2#L49-L61]` instead
  of real document IDs. The evaluation parser correctly treated `1`, `3`, and
  `2` as invalid doc IDs.
- `s24`: cited `langchain-retrieval#L42-L50`, which is directly relevant, while
  the current gold list contains `langchain-retrieval-c003` (`L34-L40`). This is
  a likely gold-label omission, not evidence that the answer was wrong.

## Partial Abstention

- `m08` began with the required fallback sentence but then answered the
  QuantizedCache side correctly and identified the missing EncoderDecoderCache
  evidence.
- The deterministic `abstained` field means "the answer starts with the required
  fallback phrase", not "the answer contains no useful information".

## Interpretation

The automatic judge should be treated as a provisional signal. The failure
audit shows why source citations, answer completeness, and refusal quality must
remain separate metrics.
