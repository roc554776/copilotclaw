---
name: select-development-port
description: Use when selecting development ports for local development. Trigger when terms like "port selection", "port number", "development port", "port conflict", "choose port", "assign port", "network port" are mentioned.
---

# Select Development Port

Selects non-conflicting ports for local development environments.

## Usage

```bash
python3 .claude/skills/select-development-port/scripts/select_ports.py
python3 scripts/select_ports.py --count 3
python3 scripts/select_ports.py --count 5 --additional-reserved-ports 3001 3002
```

## Reference

- `reference/script-internals.md` — how the script picks ports internally (candidate range, filters, COMMON_DEV_PORTS, bind-check)
- `reference/manual-selection.md` — manual port selection process (when the script cannot be used)
- `reference/list-of-tcp-and-udp-port-numbers.md` — complete IANA registered-port list
