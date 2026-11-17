# Eval comparison: v1 (base) vs v2 (head)

_fixture provider: latency is simulated model time and cost is estimated from token counts at list price._

| Metric | v1 | v2 | Status |
|---|---|---|---|
| pass_rate | 32.0% | 96.0% | improved |
| field_accuracy | 99.3% | 99.3% | same |
| emergency_recall | 100.0% | 100.0% | same |
| emergency_false_positive_rate | 0.0% | 0.0% | same |
| schema_validity | 100.0% | 100.0% | same |
| schema_first_pass_validity | 92.0% | 92.0% | same |
| hallucination_rate | 64.0% | 0.0% | improved |
| phrase_pass_rate | 96.0% | 100.0% | improved |
| cost_usd_per_message | $0.0169 | $0.0164 | improved |
| latency_ms_p50 | 1787 ms | 1832 ms | within tolerance |
| latency_ms_p95 | 2249 ms | 2271 ms | within tolerance |
| unapproved_writes | 0 | 0 | same |

- Regressions: none
- Newly failing cases: none
- Newly passing cases: c01, c03, c04, c06, c07, c08, c09, c13, c15, c16, c17, c19, c22, c23, c24, c25
