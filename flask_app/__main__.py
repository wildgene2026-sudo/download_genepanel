from __future__ import annotations

import os
import threading
import webbrowser

from waitress import serve

from .server import app


def main() -> None:
    host = os.environ.get("REFERENCE_BRIDGE_HOST", "127.0.0.1")
    port = int(os.environ.get("REFERENCE_BRIDGE_PORT", "5000"))
    local_url = f"http://127.0.0.1:{port}"
    if os.environ.get("REFERENCE_BRIDGE_OPEN_BROWSER", "1") != "0":
        threading.Timer(1.0, lambda: webbrowser.open(local_url)).start()
    print(f"Reference Bridge is ready at {local_url}", flush=True)
    if host == "0.0.0.0":
        print(f"LAN access is enabled on port {port}.", flush=True)
    serve(app, host=host, port=port, threads=8, channel_timeout=300)


if __name__ == "__main__":
    main()
