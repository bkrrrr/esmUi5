# Benchmark: the same Todo app, four ways

OpenUI5 1.154.0, 2026-11-13, median of 7 runs, headless Chrome, local node:http2 (TLS, gzip level 6), cache disabled.
Profiles: **local** = no throttling; **4g** = 40 ms RTT, 20 Mbit/s down, 5 Mbit/s up (CPU not throttled).
"ready" = first rendered list item (app usable); bytes = transferred (gzip).

## local

| | ready | first paint | DOMContentLoaded | load | requests | transferred | script | heap |
|---|---|---|---|---|---|---|---|---|
| esmUi5, bundles/ | **636 ms** | 100 ms | 271 ms | 304 ms | 21 | 1.72 MiB | 128 ms | 12 MiB |
| esmUi5, esm/ | **968 ms** | 60 ms | 445 ms | 445 ms | 464 | 2.21 MiB | 169 ms | 11 MiB |
| classic UI5, CDN build | **546 ms** | 560 ms | 142 ms | 214 ms | 24 | 1.88 MiB | 123 ms | 11 MiB |
| classic UI5, npm sources (no build) | **1,212 ms** | 1,224 ms | 623 ms | 675 ms | 452 | 2.22 MiB | 680 ms | 15 MiB |

Requests by kind (count / transferred):

| | js | css | data | fonts | app |
|---|---|---|---|---|---|
| esmUi5, bundles/ | 7 / 1386 KiB | 2 / 178 KiB | 4 / 73 KiB | 3 / 123 KiB | 5 / 3 KiB |
| esmUi5, esm/ | 447 / 1883 KiB | 2 / 178 KiB | 7 / 75 KiB | 3 / 123 KiB | 5 / 3 KiB |
| classic UI5, CDN build | 9 / 1544 KiB | 2 / 178 KiB | 5 / 75 KiB | 3 / 123 KiB | 5 / 3 KiB |
| classic UI5, npm sources (no build) | 435 / 1893 KiB | 2 / 178 KiB | 7 / 75 KiB | 3 / 123 KiB | 5 / 3 KiB |

## 4g

| | ready | first paint | DOMContentLoaded | load | requests | transferred | script | heap |
|---|---|---|---|---|---|---|---|---|
| esmUi5, bundles/ | **1,396 ms** | 88 ms | 577 ms | 644 ms | 21 | 1.72 MiB | 112 ms | 12 MiB |
| esmUi5, esm/ | **3,229 ms** | 96 ms | 756 ms | 756 ms | 464 | 2.21 MiB | 360 ms | 11 MiB |
| classic UI5, CDN build | **1,676 ms** | 1,684 ms | 283 ms | 563 ms | 24 | 1.88 MiB | 121 ms | 11 MiB |
| classic UI5, npm sources (no build) | **12,022 ms** | 12,032 ms | 9,080 ms | 9,520 ms | 452 | 2.22 MiB | 8,974 ms | 15 MiB |

Requests by kind (count / transferred):

| | js | css | data | fonts | app |
|---|---|---|---|---|---|
| esmUi5, bundles/ | 7 / 1386 KiB | 2 / 178 KiB | 4 / 73 KiB | 3 / 123 KiB | 5 / 3 KiB |
| esmUi5, esm/ | 447 / 1883 KiB | 2 / 178 KiB | 7 / 75 KiB | 3 / 123 KiB | 5 / 3 KiB |
| classic UI5, CDN build | 9 / 1544 KiB | 2 / 178 KiB | 5 / 75 KiB | 3 / 123 KiB | 5 / 3 KiB |
| classic UI5, npm sources (no build) | 435 / 1893 KiB | 2 / 178 KiB | 7 / 75 KiB | 3 / 123 KiB | 5 / 3 KiB |
