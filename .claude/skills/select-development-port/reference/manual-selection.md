# Manual Port Selection

Use this process when `select_ports.py` cannot be run (e.g. no Python environment available).

## Process

- Consult `reference/list-of-tcp-and-udp-port-numbers.md` to identify ranges that are not registered.
- Find a range with no commonly used ports.
- Choose specific ports within that range. Prefer non-round numbers (e.g. 43217, 37843) over round ones.
- Check currently listening ports on the system:
  ```bash
  lsof -iTCP -sTCP:LISTEN -P -n
  ```
- Confirm the chosen ports are not in use.
- Document the selected ports in the project.

## Round-number avoidance criteria

Avoid ports that match any of the following:
- Multiples of 1000 (e.g. 30000, 40000, 50000)
- Multiples of 100 (e.g. 30100, 30200, 40080 — wait, 40080 also matches the `0080` rule)
- Ports whose decimal representation ends in `0080` (e.g. 10080, 20080, 40080)
- Common offset patterns: x0000, x0100, x0080, x1000

Examples to avoid: 30000, 30100, 30200, 40000, 40080, 50000, 50080.
