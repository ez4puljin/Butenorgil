"""Self-signed TLS certificate generator for the LAN ERP server.

Creates a long-lived (10y) cert + key under app/data/certs/ that covers:
- localhost
- 127.0.0.1
- Every IPv4 currently bound on this host (so phones on the LAN can connect by IP).

Run this once before starting uvicorn with --ssl-keyfile / --ssl-certfile.
The startup.bat / install_and_run.bat scripts call it automatically.
"""
from __future__ import annotations

import datetime
import ipaddress
import socket
from pathlib import Path

from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa


CERT_DIR = Path(__file__).resolve().parent / "data" / "certs"
CERT_PATH = CERT_DIR / "server.crt"
KEY_PATH  = CERT_DIR / "server.key"


def _local_ips() -> list[str]:
    """Return all IPv4 addresses on this host (excluding loopback)."""
    ips: list[str] = []
    try:
        hostname = socket.gethostname()
        for addr in socket.gethostbyname_ex(hostname)[2]:
            if addr and not addr.startswith("127."):
                ips.append(addr)
    except Exception:
        pass
    # Always include 127.0.0.1
    if "127.0.0.1" not in ips:
        ips.insert(0, "127.0.0.1")
    return ips


def generate(force: bool = False) -> tuple[Path, Path]:
    """Generate self-signed cert+key (or return existing files unchanged)."""
    CERT_DIR.mkdir(parents=True, exist_ok=True)
    if not force and CERT_PATH.exists() and KEY_PATH.exists():
        return CERT_PATH, KEY_PATH

    # 2048-bit RSA key
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    name = x509.Name([
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Buten Orgil"),
        x509.NameAttribute(NameOID.COMMON_NAME, "ERP LAN Server"),
    ])

    san_entries: list[x509.GeneralName] = [
        x509.DNSName("localhost"),
    ]
    for ip in _local_ips():
        try:
            san_entries.append(x509.IPAddress(ipaddress.IPv4Address(ip)))
        except Exception:
            pass

    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=1))
        .not_valid_after(datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=365 * 10))
        .add_extension(x509.SubjectAlternativeName(san_entries), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )

    CERT_PATH.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    KEY_PATH.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    return CERT_PATH, KEY_PATH


if __name__ == "__main__":
    cert, key = generate(force=False)
    print(f"Cert: {cert}")
    print(f"Key:  {key}")
    print(f"SAN IPs: {', '.join(_local_ips())}")
