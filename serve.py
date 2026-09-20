#!/usr/bin/env python3
"""静态服务：强制每次都回源校验，避免 index.html 与 js 版本错配。"""
import functools, http.server, os, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map)
    extensions_map['.apk'] = 'application/vnd.android.package-archive'
    extensions_map['.webmanifest'] = 'application/manifest+json'
    extensions_map['.ogg'] = 'audio/ogg'
    def end_headers(self):
        # APK 与音频允许缓存，其余强制回源校验
        p = getattr(self, 'path', '')
        if p.endswith(('.apk', '.ogg', '.png')):
            self.send_header('Cache-Control', 'public, max-age=86400')
        else:
            self.send_header('Cache-Control', 'no-cache, must-revalidate')
        super().end_headers()
    def log_message(self, *a):
        pass

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    root = os.path.dirname(os.path.abspath(__file__))
    http.server.ThreadingHTTPServer(
        ('127.0.0.1', port),
        functools.partial(Handler, directory=root),
    ).serve_forever()
