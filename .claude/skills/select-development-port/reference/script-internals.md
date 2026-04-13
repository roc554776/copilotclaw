# Script Internals: select_ports.py

Detailed description of how `scripts/select_ports.py` selects ports.

## Candidate range

Only ports in the IANA registered range **1024–49151** are considered. Ports outside this range (well-known 0–1023, and dynamic/ephemeral 49152–65535) are excluded entirely.

## Three filters applied in order

**Registered-port filter** — `REGISTERED_PORTS` (defined in `port_data.py`) is a `frozenset` of ~1132 ports extracted from `reference/list-of-tcp-and-udp-port-numbers.md`. Any port present in this set is excluded. Additionally, `COMMON_DEV_PORTS` (defined in `select_ports.py`) is a small `frozenset` of widely-used development tool default ports not in the IANA list; currently: 4040 (ngrok), 4566 (LocalStack), 5173 (Vite), 6006 (Storybook). Both sets are unioned into the avoid set before candidate selection.

**Round-number filter** — `is_round_number(port)` returns `True` for:
- Multiples of 1000 (e.g. 1000, 2000, 30000)
- Multiples of 100 (e.g. 1100, 8100, 9900)
- Ports whose decimal representation ends in `0080` (e.g. 10080, 40080) — a common HTTP-alt derivative

**Bind-check filter** — after the above two filters produce a candidate list, candidates are shuffled randomly and then each is tested by attempting `socket.bind(('127.0.0.1', port))`. Only ports where bind succeeds (i.e. not currently in use) are selected. This catches ports actively listening but not in the static registered list.

## Selection and output

1. Build candidate list (range 1024–49151 minus registered and round-number ports)
2. Shuffle candidates randomly
3. Walk shuffled list; bind-check each candidate; stop when `--count` ports are collected
4. Sort selected ports ascending and print

## Additional reserved ports

`--additional-reserved-ports PORT [PORT ...]` merges the given ports into the avoid-set before building candidates. Use this for any project-specific ports that should not be selected.

## REGISTERED_PORTS source

`port_data.py` is a static snapshot generated from the Wikipedia port list. Parsing rules used during generation:

- Single-port entries: included if not all statuses are "No"
- Range entries: included (expanded) only if at least one status is Yes/Assigned/Reserved

To regenerate `port_data.py`, run `tmp/port_reparse/extract.py` then `tmp/port_reparse/generate.py`.
