#!/usr/bin/env python3
import gzip, io
from http.server import SimpleHTTPRequestHandler, HTTPServer

GZIP_TYPES = {'application/javascript', 'text/html', 'text/css', 'application/json'}
PRE_GZIPPED = {'.bin'}

class GzipHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        import os, mimetypes
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

        f = super().send_head()
        return f

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def do_GET(self):
        import mimetypes, os
        path = self.translate_path(self.path)
        ext  = os.path.splitext(path)[1].lower()
        mime = mimetypes.guess_type(path)[0] or ''

        if mime in GZIP_TYPES and ext not in PRE_GZIPPED:
            try:
                with open(path, 'rb') as f:
                    data = f.read()
            except OSError:
                self.send_error(404); return
            compressed = gzip.compress(data, compresslevel=6)
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
