### Latency at a constant arrival rate (ms)

| scenario | target | p50 | p95 | p99 | overhead p50 | overhead p95 | overhead p99 | gateway CPU ms/req | checks ok |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| chat, cache miss | direct mock | 0.31 | 0.65 | 2.43 | | | | | 100.00 % |
| chat, cache miss | gateway, platform off | 2.65 | 5.89 | 12.09 | +2.34 | +5.24 | +9.67 | – | 100.00 % |
| chat, cache miss | gateway, platform on | 3.49 | 9.37 | 30.32 | +3.18 | +8.71 | +27.89 | – | 100.00 % |
| stream, TTFB (≈TTFT) | direct mock | 0.35 | 0.66 | 1.91 | | | | | 100.00 % |
| stream, TTFB (≈TTFT) | gateway, platform off | 3.03 | 7.61 | 20.11 | +2.68 | +6.95 | +18.20 | – | 100.00 % |
| stream, TTFB (≈TTFT) | gateway, platform on | 3.45 | 10.64 | 38.21 | +3.10 | +9.98 | +36.30 | – | 100.00 % |
| stream, total | direct mock | 0.42 | 0.78 | 2.29 | | | | | 100.00 % |
| stream, total | gateway, platform off | 3.10 | 7.72 | 20.16 | +2.68 | +6.94 | +17.88 | – | 100.00 % |
| stream, total | gateway, platform on | 3.52 | 10.71 | 38.26 | +3.10 | +9.93 | +35.97 | – | 100.00 % |
| exact-cache hit | direct mock | 0.31 | 0.65 | 2.43 | | | | | 100.00 % |
| exact-cache hit | gateway, platform off | 0.73 | 1.91 | 6.94 | +0.42 | +1.25 | +4.51 | – | 100.00 % |
| exact-cache hit | gateway, platform on | 1.43 | 5.60 | 17.80 | +1.12 | +4.94 | +15.37 | – | 100.00 % |
| embeddings (2 inputs) | direct mock | 0.36 | 0.65 | 2.21 | | | | | 100.00 % |
| embeddings (2 inputs) | gateway, platform off | 2.76 | 5.32 | 10.20 | +2.40 | +4.67 | +7.99 | – | 100.00 % |
| embeddings (2 inputs) | gateway, platform on | 4.64 | 22.44 | 70.64 | +4.29 | +21.79 | +68.43 | – | 100.00 % |
| GET /healthz | gateway, platform off | 0.25 | 0.83 | 3.51 |  |  |  | – | 100.00 % |
| GET /healthz | gateway, platform on | 0.27 | 1.17 | 3.60 |  |  |  | – | 100.00 % |

Overhead = gateway percentile − direct-mock percentile for the same request shape. For
cache hits the gateway never calls the mock, so the "overhead" is relative to a full direct
upstream call (negative = faster than the 0 ms upstream itself). Gateway CPU ms/req is the
gateway process's user + system CPU time during the run divided by its requests.

### Max throughput, closed loop (req/s)

| scenario | target | req/s | p50 ms | p99 ms | gateway CPU ms/req | checks ok |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| chat, cache miss | direct mock | 4470 | 6.54 | 19.40 | – | 100.00 % |
| chat, cache miss | gateway, platform off | 1497 | 18.24 | 45.82 | – | 100.00 % |
| chat, cache miss | gateway, platform on | 980 | 28.68 | 90.09 | – | 100.00 % |
| exact-cache hit | gateway, platform off | 3009 | 8.81 | 26.07 | – | 100.00 % |
| exact-cache hit | gateway, platform on | 2149 | 12.72 | 34.51 | – | 100.00 % |
