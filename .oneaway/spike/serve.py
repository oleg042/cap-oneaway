#!/usr/bin/env python3
"""Serve the spike with the headers multithreaded WASM requires.

ONNX Runtime Web uses SharedArrayBuffer for multithreaded WASM, and browsers
only expose it on cross-origin isolated pages. Opening index.html as file://
silently drops to single-threaded, which makes the timings meaningless — the
page reports crossOriginIsolated so you can see which mode you measured.

    ./serve.py            # http://localhost:8770
    ./serve.py 9001
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class IsolatedHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        # esm.sh and huggingface.co are cross-origin; without this,
        # require-corp blocks them and nothing loads at all.
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "200" not in (args[1] if len(args) > 1 else ""):
            super().log_message(fmt, *args)


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
    root = Path(__file__).parent
    handler = partial(IsolatedHandler, directory=str(root))

    print(f"serving {root} at http://localhost:{port}")
    print("COOP/COEP set — the page should report crossOriginIsolated: true")
    try:
        ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
