"""
Tiny HTTP-only cert helper that runs alongside the main HTTPS server.

Listens on port 8080 (plain HTTP) and exposes ONLY:
  GET /                  -> setup page with install instructions + QR
  GET /rootCA.crt        -> the local CA cert
  GET /rootca.crt        -> alias

This exists so a phone that has not yet installed the local CA can still
download it (the main server runs HTTPS only and would otherwise show a
cert warning before the user can reach the cert).

Standard library only (http.server) so it has zero extra dependencies and
can stay lightweight.
"""
from __future__ import annotations

import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CERT_PATH = Path(__file__).resolve().parent / "data" / "certs" / "rootCA.crt"
PORT = 8080


def _local_ips() -> list[str]:
    ips: list[str] = []
    try:
        for addr in socket.gethostbyname_ex(socket.gethostname())[2]:
            if addr and not addr.startswith("127.") and addr not in ips:
                ips.append(addr)
    except Exception:
        pass
    return ips or ["<server-ip>"]


def _setup_html() -> bytes:
    primary = next((ip for ip in _local_ips() if ip.startswith("192.168.")), _local_ips()[0])
    https_url = f"https://{primary}:8000"
    cert_url  = f"http://{primary}:{PORT}/rootCA.crt"
    html = f"""<!doctype html>
<html lang="mn"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ERP Setup</title>
<style>
body{{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:24px auto;padding:0 16px;color:#111}}
h1{{font-size:22px;margin:0 0 4px}} h2{{font-size:16px;margin:24px 0 8px;color:#0071E3}}
a.btn{{display:inline-block;background:#0071E3;color:#fff;padding:12px 18px;border-radius:12px;font-weight:600;text-decoration:none;margin:8px 0}}
.code{{background:#f4f4f5;border-radius:8px;padding:8px 10px;font-family:ui-monospace,Consolas,monospace;font-size:14px;display:inline-block}}
ol li{{margin:6px 0}}
hr{{border:0;border-top:1px solid #eee;margin:24px 0}}
.muted{{color:#777;font-size:13px}}
</style></head><body>
<h1>ERP — Setup</h1>
<p class="muted">Утсан дээр аппыг анх удаа суулгахад дараах 2 алхмыг хийнэ.</p>

<h2>1. Сертификат суулгах</h2>
<p>Энэ товчийг даран файл татна:</p>
<p><a class="btn" href="/rootCA.crt" download>📥 rootCA.crt татах</a></p>
<ol>
  <li>Татсан файлыг нээх</li>
  <li>"Install certificate" / "Сертификат суулгах"</li>
  <li>Нэр оруулах (жишээ: <span class="code">ERP</span>)</li>
  <li>"VPN and apps" эсвэл "Trusted root CA" сонгох</li>
</ol>

<h2>2. Аппын Server тохиргоо</h2>
<ul>
  <li>Протокол: <span class="code">HTTPS</span></li>
  <li>IP: <span class="code">{primary}</span></li>
  <li>Порт: <span class="code">8000</span></li>
</ul>
<p>URL: <a href="{https_url}">{https_url}</a></p>

<hr>
<p class="muted">Cert URL (хуулах): <span class="code">{cert_url}</span></p>
<p class="muted">Энэ helper server нь cert татах л зорилготой. Үндсэн апп нь HTTPS дээр (port 8000) ажиллаж байна.</p>
</body></html>
""".strip()
    return html.encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args, **kwargs):  # quiet logs
        return

    def do_GET(self):
        path = self.path.split("?", 1)[0].lower()
        if path in ("/rootca.crt",):
            if not CERT_PATH.exists():
                self.send_error(404, "rootCA.crt not generated yet")
                return
            data = CERT_PATH.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/x-x509-ca-cert")
            self.send_header("Content-Disposition", 'attachment; filename="rootCA.crt"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path in ("/", "/setup", "/index.html"):
            data = _setup_html()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_error(404)


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    primary = next((ip for ip in _local_ips() if ip.startswith("192.168.")), _local_ips()[0])
    print(f"[cert-helper] Listening on http://{primary}:{PORT}")
    print(f"[cert-helper] Phone setup page: http://{primary}:{PORT}/")
    server.serve_forever()


if __name__ == "__main__":
    main()
