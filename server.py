"""Serves the game on http://127.0.0.1:8888 and stores song-start measurements.

POST /api/measurements with a JSON object {track_id: result, ...} merges it into
measurements.json. Everything else is served as static files, uncached.
"""
import http.server
import json
import os
import threading

ROOT = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(ROOT, 'measurements.json')
lock = threading.Lock()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_POST(self):
        if self.path != '/api/measurements':
            return self.send_error(404)
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with lock:
            db = {}
            if os.path.exists(DB):
                with open(DB) as f:
                    db = json.load(f)
            db.update(body)
            with open(DB + '.tmp', 'w') as f:
                json.dump(db, f, indent=1)
            os.replace(DB + '.tmp', DB)
        self.send_response(204)
        self.end_headers()


if __name__ == '__main__':
    http.server.ThreadingHTTPServer(('127.0.0.1', 8888), Handler).serve_forever()
