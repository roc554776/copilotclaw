#!/usr/bin/env python3
"""
Port selection tool for development environments.

Selects safe, non-conflicting ports for local development by three rules:
1. Pick from the registered-port range (1024–49151)
2. Avoid round numbers (multiples of 100, 1000, or ending in "0080")
3. Avoid registered ports (all ports listed in the IANA registered-port table)

Optionally also avoids user-specified additional ports.
"""

import argparse
import random
import socket
import sys

from port_data import REGISTERED_PORTS

# Common development tool default ports that are NOT in IANA registered ports
# but are widely used. Avoiding these reduces accidental conflicts.
COMMON_DEV_PORTS: frozenset[int] = frozenset({
    4040,   # ngrok (local tunnel)
    4566,   # LocalStack (AWS cloud emulator default endpoint)
    5173,   # Vite dev server (also in IANA, included here for explicitness)
    6006,   # Storybook (also in IANA, included here for explicitness)
})


def is_round_number(port: int) -> bool:
    """Return True if port is a round number (きりがいい数)."""
    # Multiples of 1000 (e.g. 1000, 2000, 3000, 10000, 30000)
    if port % 1000 == 0:
        return True
    # Multiples of 100 (e.g. 1100, 1200, 8100, 9900)
    if port % 100 == 0:
        return True
    # Derivative of 80 (e.g. 10080, 20080, 30080, 40080)
    if str(port).endswith('0080'):
        return True
    return False


def is_port_in_use(port: int) -> bool:
    """Return True if a port is already bound on 127.0.0.1."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(('127.0.0.1', port))
            return False
        except OSError:
            return True


def select_safe_ports(count: int, additional_reserved: set[int]) -> list[int]:
    """Select safe development ports using the three rules."""
    avoid = REGISTERED_PORTS | COMMON_DEV_PORTS | additional_reserved

    candidates = [
        port
        for port in range(1024, 49152)
        if port not in avoid and not is_round_number(port)
    ]

    if len(candidates) < count:
        print(f"Warning: Only {len(candidates)} safe ports available", file=sys.stderr)
        count = len(candidates)

    random.shuffle(candidates)

    selected = []
    for port in candidates:
        if len(selected) >= count:
            break
        if not is_port_in_use(port):
            selected.append(port)

    selected.sort()
    return selected


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Select safe development ports',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  %(prog)s
  %(prog)s --count 3
  %(prog)s --count 5 --additional-reserved-ports 3000 3001
        '''
    )
    parser.add_argument(
        '--additional-reserved-ports',
        nargs='*',
        default=[],
        metavar='PORT',
        help='Additional ports to avoid (space-separated)'
    )
    parser.add_argument(
        '--count',
        type=int,
        default=5,
        help='Number of ports to select (default: 5)'
    )

    args = parser.parse_args()

    additional_reserved: set[int] = set()
    for port_str in (args.additional_reserved_ports or []):
        try:
            port = int(port_str)
            if 1 <= port <= 65535:
                additional_reserved.add(port)
            else:
                print(f"Warning: Port {port} out of range, ignored", file=sys.stderr)
        except ValueError:
            print(f"Warning: Invalid port '{port_str}', ignored", file=sys.stderr)

    print("Selecting available ports...", file=sys.stderr)
    selected_ports = select_safe_ports(args.count, additional_reserved)

    print("\nSelected development ports:")
    for i, port in enumerate(selected_ports, 1):
        print(f"  {i}. {port} - Available (verified by bind)")

    print()
    if not args.additional_reserved_ports:
        print("Run with --additional-reserved-ports to exclude more ports.")


if __name__ == '__main__':
    main()
