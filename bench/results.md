# Benchmark: the same Todo app, four ways

OpenUI5 1.154.0, 2026-11-12, median of 7 runs, headless Chrome, local node:http2 (TLS, gzip level 6), cache disabled.
Profiles: **local** = no throttling; **4g** = 40 ms RTT, 20 Mbit/s down, 5 Mbit/s up (CPU not throttled).
"ready" = first rendered list item (app usable); bytes = transferred (gzip).

## local

| | ready | first paint | DOMContentLoaded | load | requests | transferred | script | heap |
|---|---|---|---|---|---|---|---|---|
| UI5 Next, bundles/ | **519 ms** | 56 ms | 201 ms | 219 ms | 26 | 1.71 MiB | 117 ms | 12 MiB |
| UI5 Next, esm/ | **894 ms** | 40 ms | 409 ms | 410 ms | 464 | 2.19 MiB | 166 ms | 11 MiB |
| classic UI5, CDN build | **543 ms** | 556 ms | 136 ms | 205 ms | 24 | 1.88 MiB | 121 ms | 11 MiB |
| classic UI5, npm sources (no build) | **1,159 ms** | 1,172 ms | 633 ms | 684 ms | 452 | 2.22 MiB | 686 ms | 15 MiB |

Requests by kind (count / transferred):

| | js | css | data | fonts | app |
|---|---|---|---|---|---|
| UI5 Next, bundles/ | 13 / 1376 KiB | 2 / 178 KiB | 4 / 73 KiB | 3 / 123 KiB | 4 / 3 KiB |
| UI5 Next, esm/ | 448 / 1868 KiB | 2 / 178 KiB | 7 / 75 KiB | 3 / 123 KiB | 4 / 3 KiB |
| classic UI5, CDN build | 9 / 1544 KiB | 2 / 178 KiB | 5 / 75 KiB | 3 / 123 KiB | 5 / 3 KiB |
| classic UI5, npm sources (no build) | 435 / 1893 KiB | 2 / 178 KiB | 7 / 75 KiB | 3 / 123 KiB | 5 / 3 KiB |

## 4g

| | ready | first paint | DOMContentLoaded | load | requests | transferred | script | heap |
|---|---|---|---|---|---|---|---|---|
| UI5 Next, bundles/ | **1,375 ms** | 84 ms | 561 ms | 628 ms | 26 | 1.71 MiB | 114 ms | 12 MiB |
| UI5 Next, esm/ | **3,203 ms** | 88 ms | 730 ms | 731 ms | 464 | 2.19 MiB | 361 ms | 11 MiB |
| classic UI5, CDN build | **1,658 ms** | 1,664 ms | 275 ms | 556 ms | 24 | 1.88 MiB | 119 ms | 11 MiB |
| classic UI5, npm sources (no build) | **12,293 ms** | 12,300 ms | 9,247 ms | 9,693 ms | 452 | 2.22 MiB | 9,195 ms | 15 MiB |

Requests by kind (count / transferred):

| | js | css | data | fonts | app |
|---|---|---|---|---|---|
| UI5 Next, bundles/ | 13 / 1376 KiB | 2 / 178 KiB | 4 / 73 KiB | 3 / 123 KiB | 4 / 3 KiB |
| UI5 Next, esm/ | 448 / 1869 KiB | 2 / 178 KiB | 7 / 75 KiB | 3 / 123 KiB | 4 / 3 KiB |
| classic UI5, CDN build | 9 / 1544 KiB | 2 / 178 KiB | 5 / 75 KiB | 3 / 123 KiB | 5 / 3 KiB |
| classic UI5, npm sources (no build) | 435 / 1893 KiB | 2 / 178 KiB | 7 / 75 KiB | 3 / 123 KiB | 5 / 3 KiB |
