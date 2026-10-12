#!/usr/bin/env python3
"""Loopback-only, single-request debugging server for the NF4 adapter."""

import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import pathlib

from neohorse_decision.systemone import validate_request, with_confidence
from quantized_runtime import QuantizedDecisionEngine


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", default=str(pathlib.Path(__file__).parent / "model"))
    parser.add_argument("--head-checkpoint", type=pathlib.Path, help="Optional trained pointer-head checkpoint")
    parser.add_argument("--lora-adapter", type=pathlib.Path, help="Optional local PEFT adapter directory")
    parser.add_argument("--port", type=int, default=18081)
    args = parser.parse_args()
    engine = QuantizedDecisionEngine(args.model_dir, head_checkpoint=args.head_checkpoint, lora_adapter=args.lora_adapter)

    class Handler(BaseHTTPRequestHandler):
        def reply(self, status, value):
            body = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path != "/health":
                return self.reply(404, {"error": "not_found"})
            self.reply(200, {"ready": True, "runtime": engine.runtime_info()})

        def do_POST(self):
            if self.path not in ("/v1/decision", "/v1/systemone"):
                return self.reply(404, {"error": "not_found"})
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if self.headers.get("Transfer-Encoding") or not 0 < size <= 1024 * 1024:
                    return self.reply(413, {"error": "content_length_required_and_limited_to_1_MiB"})
                request = json.loads(self.rfile.read(size))
                if not isinstance(request, dict):
                    raise ValueError("Request must be a JSON object")
                if self.path == "/v1/systemone":
                    request = validate_request(request)
                result = with_confidence(engine.predict(request))
                self.reply(200, result)
            except (ValueError, TypeError, KeyError) as error:
                self.reply(400, {"error": "invalid_request", "detail": str(error)})
            except Exception as error:
                # Details remain in the local terminal rather than being exposed over HTTP.
                self.log_error("Inference failed: %s", type(error).__name__)
                self.reply(500, {"error": "inference_failed"})

    print(f"READY http://127.0.0.1:{args.port}; debugging only", flush=True)
    with HTTPServer(("127.0.0.1", args.port), Handler) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
