#!/usr/bin/python3
"""Return Linux SO_PEERCRED for one inherited Unix stream socket.

This helper is a deliberately tiny privilege boundary. It accepts no arguments,
does not read request bytes, and never prints diagnostic or peer-controlled data.
"""

from __future__ import annotations

import os
import socket
import struct
import sys


EXIT_FAILURE = 70


def main() -> int:
    if len(sys.argv) != 1 or not hasattr(socket, "SO_PEERCRED"):
        return EXIT_FAILURE

    inherited: socket.socket | None = None
    try:
        inherited = socket.socket(fileno=0)
        if inherited.family != socket.AF_UNIX or inherited.type != socket.SOCK_STREAM:
            return EXIT_FAILURE
        size = struct.calcsize("3i")
        raw = inherited.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, size)
        if len(raw) != size:
            return EXIT_FAILURE
        pid, uid, gid = struct.unpack("3i", raw)
        if pid <= 0 or uid < 0 or gid < 0:
            return EXIT_FAILURE
        payload = f'{{"pid":{pid},"uid":{uid},"gid":{gid}}}\n'.encode("ascii")
        os.write(1, payload)
        return 0
    except (OSError, ValueError, struct.error):
        return EXIT_FAILURE
    finally:
        if inherited is not None:
            try:
                inherited.detach()
            except OSError:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
