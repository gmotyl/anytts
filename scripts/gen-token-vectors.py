"""Generate golden Sec-MS-GEC v2 vectors from the reference implementation.

Requires rany2/edge-tts >= 7.3.0 (verified with 7.3.1), whose
`edge_tts.drm.generate_sec_ms_gec_v2` is the source of truth for
`src/engines/edge/token.ts`.

The clock is pinned by monkeypatching `DRM.get_unix_timestamp`, so the
public zero-argument path (`DRM.generate_sec_ms_gec`) is exercised too.

Usage:
    python -I scripts/gen-token-vectors.py > src/engines/edge/__tests__/token-vectors.json
"""

import json
import sys

import edge_tts
from edge_tts import constants
from edge_tts.drm import DRM, _token_hash

# Fixed moments: epoch-ish, a window boundary, mid-window with a fraction,
# the outage start (2026-10-10), today-ish, and far future.
TIMESTAMPS = [
    0,
    1_700_000_000,
    1_700_000_100.75,
    1_760_054_399.999,
    1_791_590_400,
    1_791_590_699,
    1_791_590_700,
    1_792_000_000.5,
    1_800_000_000,
    4_102_444_800,
]


def main() -> None:
    vectors = []
    for ts in TIMESTAMPS:
        # Token computation is lru_cached on its input; clear between runs.
        _token_hash.cache_clear()
        DRM.get_unix_timestamp = staticmethod(lambda ts=ts: float(ts))
        vectors.append({"unixSeconds": ts, "token": DRM.generate_sec_ms_gec()})
    json.dump(
        {
            "source": f"edge-tts {edge_tts.__version__}",
            "secMsGecVersion": constants.SEC_MS_GEC_VERSION,
            "vectors": vectors,
        },
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
