# Answer Evaluation

Generated: 2026-11-25T09:35:10.924Z

> Answer correctness and faithfulness are N/A until explicit judgement records cover the answers.
> Citation accuracy checks cited doc_id and line ranges against gold chunks from the evaluation dataset.
> Refusal accuracy is computed only for questions whose dataset type is `unanswerable`.
> A returned candidate is not itself an incorrect answer; generation and refusal are evaluated separately.
> Some correctness and faithfulness labels came from an automated LLM judge and require human spot-checking.

| Strategy | Answers | Judged | Answer acc. | Faithfulness | Citation gold acc. | Citation coverage | Refusal acc. | False refusal | Avg latency ms | P95 latency ms | Avg evidence calls | Avg tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| no_rag | 60/60 | 50 | 0.6800 | N/A | N/A | 0.0000 | 1.0000 | 0.2400 | 7147.6000 | 14334.0000 | 0.0000 | 1176.4500 |
| dense | 60/60 | 50 | 0.8800 | 0.9800 | 0.5981 | 0.9600 | 1.0000 | 0.1000 | 3137.7000 | 5674.0000 | 0.0000 | 2309.7000 |
| hybrid | 60/60 | 50 | 0.9200 | 0.9800 | 0.5877 | 0.9600 | 1.0000 | 0.1000 | 3042.4333 | 5573.0000 | 0.0000 | 2413.2333 |
| agentic | 60/60 | 50 | 0.9800 | 0.9800 | 0.4664 | 0.9600 | 1.0000 | 0.0000 | 9630.4000 | 18289.0000 | 2.1500 | 8559.2667 |
