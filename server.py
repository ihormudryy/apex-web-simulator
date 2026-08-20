#!/usr/bin/env python3
import gzip, mimetypes, os
from http.server import SimpleHTTPRequestHandler, HTTPServer

GZIP_TYPES = {'application/javascript', 'text/html', 'text/css', 'application/json'}
PRE_GZIPPED = {'.bin'}


class GzipHandler(SimpleHTTPRequestHandler):
    _gzip_cache = {}

    def send_head(self):
        path = self.translate_path(self.path)
        ext  = os.path.splitext(path)[1].lower()

        if ext in PRE_GZIPPED:
            try:
                f = open(path, 'rb')
            except OSError:
                self.send_error(404); return None
            stat = os.fstat(f.fileno())
            mime = mimetypes.guess_type(path)[0] or 'application/octet-stream'
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Encoding', 'gzip')
            self.send_header('Content-Length', str(stat.st_size))
            self.end_headers()
            return f

        return super().send_head()

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        # Local demo: never let the browser keep ES modules. A half-updated
        # cache (new EngineAudio.js, old engineTone.js) surfaces as missing
        # named exports rather than an obvious "stale file" error.
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        path = self.translate_path(self.path)
        ext  = os.path.splitext(path)[1].lower()
        mime = mimetypes.guess_type(path)[0] or ''

        if mime in GZIP_TYPES and ext not in PRE_GZIPPED:
            try:
                mtime = os.path.getmtime(path)
                with open(path, 'rb') as f:
                    data = f.read()
            except OSError:
                self.send_error(404); return
            key = (path, mtime, len(data))
            compressed = GzipHandler._gzip_cache.get(key)
            if compressed is None:
                compressed = gzip.compress(data, compresslevel=6)
                GzipHandler._gzip_cache[key] = compressed
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Encoding', 'gzip')
            self.send_header('Content-Length', str(len(compressed)))
            self.end_headers()
            self.wfile.write(compressed)
        else:
            super().do_GET()


if __name__ == '__main__':
    HTTPServer(('', 8000), GzipHandler).serve_forever()
