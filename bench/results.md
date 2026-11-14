# Benchmark: the same Todo app, four ways

OpenUI5 1.154.0, 2026-11-14, median of 5 runs, headless Chrome, local node:http2 (TLS, gzip level 6), cache disabled.
Profiles: **local** = no throttling; **4g** = 40 ms RTT, 20 Mbit/s down, 5 Mbit/s up (CPU not throttled).
"ready" = first rendered list item (app usable); bytes = transferred (gzip).

## local

| | ready | first paint | DOMContentLoaded | load | requests | transferred | script | heap |
|---|---|---|---|---|---|---|---|---|
| esmUi5, bundles/ | **689 ms** | 72 ms | 241 ms | 260 ms | 21 | 1.94 MiB | 119 ms | 13 MiB |
| esmUi5, esm/ | **1,061 ms** | 92 ms | 453 ms | 453 ms | 464 | 2.39 MiB | 222 ms | 13 MiB |
| classic UI5, CDN build | **555 ms** | 568 ms | 135 ms | 207 ms | 24 | 1.88 MiB | 122 ms | 11 MiB |
| classic UI5, npm sources (no build) | **1,290 ms** | 1,304 ms | 662 ms | 718 ms | 452 | 2.22 MiB | 724 ms | 15 MiB |

Requests by kind (count / transferred):

| | js | css | data | fonts | app |
|---|---|---|---|---|---|
| esmUi5, bundles/ | 7 / 1612 KiB | 2 / 178 KiB | 4 / 73 KiB | 3 / 123 KiB | 5 / 3 KiB |
| esmUi5, esm/ | 447 / 2067 KiB | 2 / 178 KiB | 7 / 75 KiB | 3 / 123 KiB | 5 / 3 KiB |
| classic UI5, CDN build | 9 / 1544 KiB | 2 / 178 KiB | 5 / 75 KiB | 3 / 123 KiB | 5 / 3 KiB |
| classic UI5, npm sources (no build) | 435 / 1893 KiB | 2 / 178 KiB | 7 / 75 KiB | 3 / 123 KiB | 5 / 3 KiB |

## 4g

| | ready | first paint | DOMContentLoaded | load | requests | transferred | script | heap |
|---|---|---|---|---|---|---|---|---|
| esmUi5, bundles/ | **1,602 ms** | 92 ms | 613 ms | 680 ms | 21 | 1.94 MiB | 119 ms | 13 MiB |
| esmUi5, esm/ | **3,509 ms** | 92 ms | 822 ms | 822 ms | 464 | 2.39 MiB | 431 ms | 13 MiB |
| classic UI5, CDN build | **1,718 ms** | 1,724 ms | 292 ms | 576 ms | 24 | 1.88 MiB | 121 ms | 11 MiB |
| classic UI5, npm sources (no build) | **12,899 ms** | 12,912 ms | 9,777 ms | 10,237 ms | 452 | 2.22 MiB | 9,712 ms | 15 MiB |

Requests by kind (count / transferred):

| | js | css | data | fonts | app |
|---|---|---|---|---|---|
| esmUi5, bundles/ | 7 / 1612 KiB | 2 / 178 KiB | 4 / 73 KiB | 3 / 123 KiB | 5 / 3 KiB |
| esmUi5, esm/ | 447 / 2067 KiB | 2 / 178 KiB | 7 / 75 KiB | 3 / 123 KiB | 5 / 3 KiB |
| classic UI5, CDN build | 9 / 1544 KiB | 2 / 178 KiB | 5 / 75 KiB | 3 / 123 KiB | 5 / 3 KiB |
| classic UI5, npm sources (no build) | 435 / 1893 KiB | 2 / 178 KiB | 7 / 75 KiB | 3 / 123 KiB | 5 / 3 KiB |
