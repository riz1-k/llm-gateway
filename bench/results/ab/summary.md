| platform | scenario | build | p50 ms | p95 ms | p99 ms | gateway CPU ms/req |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| off | chat miss | A | 2.52 | 5.02 | 13.01 | 1.38 |
| off | chat miss | B | 2.52 | 5.61 | 12.50 | 1.39 |
| off | exact-cache hit | A | 0.85 | 1.73 | 5.51 | 0.91 |
| off | exact-cache hit | B | 0.79 | 1.72 | 8.19 | 0.79 |
| off | embeddings | A | 7.46 | 24.08 | 39.13 | 2.33 |
| off | embeddings | B | 8.23 | 46.88 | 149.83 | 2.33 |
| on | chat miss | A | 60.44 | 206.65 | 394.85 | 3.34 |
| on | chat miss | B | 20.22 | 111.90 | 164.44 | 3.22 |
| on | exact-cache hit | A | 6.70 | 48.00 | 119.49 | 2.47 |
| on | exact-cache hit | B | 9.69 | 59.62 | 163.06 | 2.59 |
| on | embeddings | A | 38.74 | 156.72 | 252.91 | 3.27 |
| on | embeddings | B | 9.20 | 59.33 | 148.20 | 2.56 |
