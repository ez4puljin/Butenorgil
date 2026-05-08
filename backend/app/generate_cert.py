"""
Local CA + server cert generator (mkcert-style).

On first run:
- Creates a local Certificate Authority under app/data/certs/.
- Installs that CA into the Windows current-user trusted-root store
  via certutil so Chrome/Edge on this machine immediately trust the
  server cert with NO 'NET::ERR_CERT_AUTHORITY_INVALID' warning.

On every run:
- (Re)generates a server cert signed by the local CA. SAN covers
  localhost + every IPv4 currently bound on this host (so phones
  on the LAN can connect by IP).

Other devices (phones, other PCs): download the CA from
https://<server>:8000/rootca.crt and install it as a trusted root.
After that they too will load the site without warnings.
"""
from __future__ import annotations

import datetime
import ipaddress
import socket
import subprocess
import sys
from pathlib import Path

from cryptography import x509
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa


CERT_DIR = Path(__file__).resolve().parent / "data" / "certs"
CA_CRT  = CERT_DIR / "rootCA.crt"
CA_KEY  = CERT_DIR / "rootCA.key"
SRV_CRT = CERT_DIR / "server.crt"
SRV_KEY = CERT_DIR / "server.key"

CA_CN = "Buten Orgil ERP Local CA"


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _local_ips() -> list[str]:
    ips: list[str] = ["127.0.0.1"]
    try:
        hostname = socket.gethostname()
        for addr in socket.gethostbyname_ex(hostname)[2]:
            if addr and not addr.startswith("127.") and addr not in ips:
                ips.append(addr)
    except Exception:
        pass
    return ips


# ── CA ───────────────────────────────────────────────────────────────────────

def _build_ca() -> tuple[x509.Certificate, rsa.RSAPrivateKey]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Buten Orgil ERP"),
        x509.NameAttribute(NameOID.COMMON_NAME, CA_CN),
    ])
    now = _now()
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=365 * 20))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True, key_encipherment=False, key_cert_sign=True,
                crl_sign=True, content_commitment=False, data_encipherment=False,
                key_agreement=False, encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(key.public_key()),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    return cert, key


def _ensure_ca() -> tuple[x509.Certificate, rsa.RSAPrivateKey]:
    if CA_CRT.exists() and CA_KEY.exists():
        try:
            cert = x509.load_pem_x509_certificate(CA_CRT.read_bytes())
            key  = serialization.load_pem_private_key(CA_KEY.read_bytes(), password=None)
            return cert, key
        except Exception:
            pass  # corrupt — regenerate

    cert, key = _build_ca()
    CA_CRT.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    CA_KEY.write_bytes(key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ))
    print(f"[cert] Created new local CA: {CA_CRT}")
    return cert, key


# ── Server cert ──────────────────────────────────────────────────────────────

def _build_server_cert(
    ca_cert: x509.Certificate,
    ca_key:  rsa.RSAPrivateKey,
    ips:     list[str],
) -> tuple[x509.Certificate, rsa.RSAPrivateKey]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Buten Orgil ERP"),
        x509.NameAttribute(NameOID.COMMON_NAME, "ERP LAN Server"),
    ])

    san: list[x509.GeneralName] = [x509.DNSName("localhost")]
    for ip in ips:
        try:
            san.append(x509.IPAddress(ipaddress.IPv4Address(ip)))
        except Exception:
            pass

    now = _now()
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=365 * 10))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),
            critical=False,
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_cert.public_key()),
            critical=False,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(key.public_key()),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )
    return cert, key


def _server_cert_san_changed(ips: list[str]) -> bool:
    """True if the existing server cert's SAN no longer matches our LAN IPs."""
    if not (SRV_CRT.exists() and SRV_KEY.exists()):
        return True
    try:
        cert = x509.load_pem_x509_certificate(SRV_CRT.read_bytes())
        san = cert.extensions.get_extension_for_class(
            x509.SubjectAlternativeName
        ).value
        cert_ips = {str(v) for v in san.get_values_for_type(x509.IPAddress)}
        return cert_ips != set(ips)
    except Exception:
        return True


def _write_server_cert(ca_cert: x509.Certificate, ca_key: rsa.RSAPrivateKey, ips: list[str]) -> None:
    cert, key = _build_server_cert(ca_cert, ca_key, ips)
    SRV_CRT.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    SRV_KEY.write_bytes(key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ))
    print(f"[cert] Server cert SAN: localhost, {', '.join(ips)}")


# ── Windows trust-store install ──────────────────────────────────────────────

def _ca_already_trusted_windows() -> bool:
    """Check if our CA's CN already appears in the Windows current-user Root store."""
    try:
        # Querying by CN is much faster than dumping the entire store.
        r = subprocess.run(
            ["certutil", "-user", "-store", "Root", CA_CN],
            capture_output=True, text=True, timeout=60,
            encoding="utf-8", errors="replace",
        )
        return r.returncode == 0 and CA_CN in (r.stdout or "")
    except Exception:
        return False


def _install_ca_windows() -> None:
    if sys.platform != "win32":
        return
    if _ca_already_trusted_windows():
        return
    try:
        r = subprocess.run(
            ["certutil", "-user", "-addstore", "-f", "Root", str(CA_CRT)],
            capture_output=True, text=True, timeout=60,
            encoding="utf-8", errors="replace",
        )
        if r.returncode == 0:
            print("[cert] Installed local CA into Windows current-user Root store.")
            print("[cert] Chrome / Edge on this machine will now trust the cert with no warning.")
        else:
            print(f"[cert] WARN: certutil exit {r.returncode}. stderr: {(r.stderr or '').strip()}")
    except Exception as e:
        print(f"[cert] WARN: could not install CA: {e}")


# ── Public API ───────────────────────────────────────────────────────────────

def generate() -> tuple[Path, Path]:
    """Ensure CA + server cert exist and are current. Idempotent."""
    CERT_DIR.mkdir(parents=True, exist_ok=True)
    ca_cert, ca_key = _ensure_ca()
    ips = _local_ips()
    if _server_cert_san_changed(ips):
        _write_server_cert(ca_cert, ca_key, ips)
    _install_ca_windows()
    return SRV_CRT, SRV_KEY


if __name__ == "__main__":
    cert, key = generate()
    print(f"Server cert: {cert}")
    print(f"Server key:  {key}")
    print(f"Local CA:    {CA_CRT}")
    print()
    print("Other devices: download https://<server-ip>:8000/rootca.crt and install as trusted root.")
