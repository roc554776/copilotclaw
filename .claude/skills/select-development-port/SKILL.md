---
name: select-development-port
description: Use when selecting development ports for local development. Trigger when terms like "port selection", "port number", "development port", "port conflict", "choose port", "assign port", "network port" are mentioned.
---

# Select Development Port

Guide for selecting appropriate development ports to avoid conflicts.

## Why Careful Port Selection Matters

Development ports must be chosen carefully to avoid collisions between projects and services. Using common ports (like 3000, 8000, 8080, 30000) frequently causes conflicts.

## Port Selection Guidelines

1. **Avoid Well-Known Ports (0-1023)**: Reserved for system services
2. **Avoid Common Development Ports**: 3000, 4000, 5000, 8000, 8080, 9000, 30000, etc.
3. **Avoid Round Numbers and Derivatives**: Round numbers and their common derivatives are frequently used:
   - Base round numbers: 30000, 40000, 50000, etc.
   - Derived round numbers: 30100, 30200, 40080, 50000, etc.
   - Common offset patterns: x0000, x0100, x0080, x1000, etc.
   - Examples to avoid: 30000, 30100, 30200, 40000, 40080, 50000, 50080
4. **Use Registered Ports (1024-49151)**: Check the port list for unused ranges
5. **Use Unique Ports Even for Standard Tools**: Even LocalStack (default 4566) should use a project-specific port

## Port Selection Process

1. Check [list-of-tcp-and-udp-port-numbers.md](./list-of-tcp-and-udp-port-numbers.md) for registered ports
2. Find a range that is not commonly used
3. Select specific ports within that range (prefer non-round numbers like 43217, 37843)
4. Document the selected ports in the project

## Reference

See [list-of-tcp-and-udp-port-numbers.md](./list-of-tcp-and-udp-port-numbers.md) for the complete list of registered ports.
