### Latency at a constant arrival rate (ms)

| scenario | target | p50 | p95 | p99 | overhead p50 | overhead p95 | overhead p99 | gateway CPU ms/req | checks ok |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| chat, cache miss | direct mock | 0.34 | 0.74 | 2.88 | | | | | 100.00 % |
| chat, cache miss | gateway, platform off | 2.60 | 5.62 | 17.10 | +2.26 | +4.88 | +14.22 | – | 100.00 % |
| chat, cache miss | gateway, platform on | 3.76 | 12.31 | 49.97 | +3.41 | +11.57 | +47.09 | – | 100.00 % |
| stream, TTFB (≈TTFT) | direct mock | 0.35 | 0.77 | 3.30 | | | | | 100.00 % |
| stream, TTFB (≈TTFT) | gateway, platform off | 4.44 | 15.24 | 32.16 | +4.08 | +14.47 | +28.85 | – | 100.00 % |
| stream, TTFB (≈TTFT) | gateway, platform on | 3.57 | 12.62 | 28.37 | +3.21 | +11.85 | +25.07 | – | 100.00 % |
| stream, total | direct mock | 0.42 | 0.99 | 3.66 | | | | | 100.00 % |
| stream, total | gateway, platform off | 4.67 | 15.62 | 32.27 | +4.25 | +14.62 | +28.60 | – | 100.00 % |
| stream, total | gateway, platform on | 3.65 | 12.92 | 28.46 | +3.23 | +11.92 | +24.79 | – | 100.00 % |
| exact-cache hit | direct mock | 0.34 | 0.74 | 2.88 | | | | | 100.00 % |
| exact-cache hit | gateway, platform off | 0.83 | 3.44 | 19.21 | +0.48 | +2.70 | +16.33 | – | 100.00 % |
| exact-cache hit | gateway, platform on | 2.06 | 10.85 | 23.34 | +1.72 | +10.11 | +20.45 | – | 100.00 % |
| embeddings (2 inputs) | direct mock | 0.30 | 0.55 | 1.75 | | | | | 100.00 % |
| embeddings (2 inputs) | gateway, platform off | 2.84 | 6.41 | 11.73 | +2.55 | +5.86 | +9.98 | – | 100.00 % |
| embeddings (2 inputs) | gateway, platform on | 4.72 | 26.19 | 90.90 | +4.42 | +25.63 | +89.15 | – | 100.00 % |
| GET /healthz | gateway, platform off | 0.28 | 1.06 | 3.77 |  |  |  | – | 100.00 % |
| GET /healthz | gateway, platform on | 0.30 | 1.28 | 3.78 |  |  |  | – | 100.00 % |

Overhead = gateway percentile − direct-mock percentile for the same request shape. For
cache hits the gateway never calls the mock, so the "overhead" is relative to a full direct
upstream call (negative = faster than the 0 ms upstream itself). Gateway CPU ms/req is the
gateway process's user + system CPU time during the run divided by its requests.

### Max throughput, closed loop (req/s)

| scenario | target | req/s | p50 ms | p99 ms | gateway CPU ms/req | checks ok |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| chat, cache miss | direct mock | 4198 | 6.72 | 21.89 | – | 100.00 % |
| chat, cache miss | gateway, platform off | 1243 | 21.94 | 65.81 | – | 100.00 % |
| chat, cache miss | gateway, platform on | 651 | 45.06 | 140.27 | – | 100.00 % |
| exact-cache hit | gateway, platform off | 3630 | 7.55 | 21.63 | – | 100.00 % |
| exact-cache hit | gateway, platform on | 2017 | 13.31 | 37.70 | – | 100.00 % |
