"""
Security primitives: PIN hashing and stateless signed tokens.

- PINs are never stored in plaintext. ``hash_pin`` produces a PBKDF2-HMAC-SHA256
  hash with a per-user random salt; ``verify_pin`` compares in constant time.
- Session tokens are HMAC-signed and carry an issue time, so they expire.
- The signing key comes from ``CLOCKIFY_SECRET_KEY``. There is no hardcoded
  default: in production the app refuses to start without it, and in local
  development an ephemeral key is generated (tokens then stop working on
  restart, which is the correct behaviour for a throwaway key).
"""
import base64
import hashlib
import hmac
import logging
import os
import secrets
import time
from typing import Optional, Tuple

logger = logging.getLogger("clockify.security")

PIN_ALGORITHM = "pbkdf2_sha256"
PIN_ITERATIONS = 120_000

EMPLOYEE_TOKEN_TTL_SECONDS = int(os.environ.get("CLOCKIFY_EMPLOYEE_TOKEN_TTL", 12 * 3600))
ADMIN_TOKEN_TTL_SECONDS = int(os.environ.get("CLOCKIFY_ADMIN_TOKEN_TTL", 8 * 3600))
CLOCK_SKEW_SECONDS = 60  # tolerate a small amount of clock drift when checking iat


# ---------------------------------------------------------------------------
# Signing key
# ---------------------------------------------------------------------------

def _load_secret_key() -> str:
    key = (os.environ.get("CLOCKIFY_SECRET_KEY") or "").strip()
    if key:
        return key

    # On serverless platforms each instance would otherwise generate a different
    # random key, silently invalidating sessions at random. A database URL is stable
    # across instances and is secret, so derive from it when one is configured;
    # rotating that credential simply signs everyone out.
    database_url = (
        os.environ.get("DATABASE_URL")
        or os.environ.get("POSTGRES_URL")
        or os.environ.get("POSTGRES_PRISMA_URL")
        or ""
    ).strip()
    if database_url:
        logger.warning(
            "CLOCKIFY_SECRET_KEY is not set: deriving the session key from the database URL. "
            "Set CLOCKIFY_SECRET_KEY explicitly to decouple the two."
        )
        return hmac.new(
            b"clockify/session-key/v1", database_url.encode("utf-8"), hashlib.sha256
        ).hexdigest()

    # Never take the deployment down over a missing session key: an ephemeral key
    # still issues unforgeable tokens, it just means sessions do not survive a
    # restart or a jump between serverless instances.
    logger.error(
        "CLOCKIFY_SECRET_KEY is not set. Using an ephemeral session key: sessions will not "
        "survive a restart. Generate one with: "
        "python -c \"import secrets; print(secrets.token_urlsafe(48))\""
    )
    return secrets.token_urlsafe(48)


SECRET_KEY = _load_secret_key()


# ---------------------------------------------------------------------------
# PIN hashing
# ---------------------------------------------------------------------------

def hash_pin(pin: str) -> str:
    """Return a salted PBKDF2 hash of ``pin`` in a self-describing format."""
    if not isinstance(pin, str) or not pin:
        raise ValueError("PIN must be a non-empty string")
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt.encode("utf-8"), PIN_ITERATIONS).hex()
    return f"{PIN_ALGORITHM}${PIN_ITERATIONS}${salt}${digest}"


def is_pin_hash(value: object) -> bool:
    """True when ``value`` is already a hash produced by :func:`hash_pin`."""
    return isinstance(value, str) and value.startswith(f"{PIN_ALGORITHM}$")


def verify_pin(pin: Optional[str], stored: Optional[str]) -> bool:
    """Constant-time check of ``pin`` against a stored hash. Legacy plaintext never matches."""
    if not pin or not stored or not is_pin_hash(stored):
        return False
    try:
        _algorithm, iterations, salt, digest = str(stored).split("$", 3)
        candidate = hashlib.pbkdf2_hmac(
            "sha256", pin.encode("utf-8"), salt.encode("utf-8"), int(iterations)
        ).hex()
    except (TypeError, ValueError):
        return False
    return hmac.compare_digest(candidate, digest)


# ---------------------------------------------------------------------------
# Token helpers
# ---------------------------------------------------------------------------

def _sign(payload: str) -> str:
    return hmac.new(SECRET_KEY.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def _strip_bearer(token: Optional[str]) -> Optional[str]:
    if not token:
        return None
    clean = token.strip().strip("\"'")
    if clean.lower().startswith("bearer "):
        clean = clean[7:].strip()
    return clean or None


def _b64encode(value: str) -> str:
    return base64.urlsafe_b64encode(value.encode("utf-8")).decode("ascii").rstrip("=")


def _b64decode(value: str) -> Optional[str]:
    try:
        padded = value + "=" * (-len(value) % 4)
        return base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
    except Exception:
        return None


def _is_fresh(issued: int, ttl: int) -> bool:
    now = time.time()
    return (now - issued) <= ttl and (issued - now) <= CLOCK_SKEW_SECONDS


def create_employee_token(employee_id: int) -> str:
    issued = int(time.time())
    payload = f"emp:{int(employee_id)}:{issued}"
    return f"emp.{int(employee_id)}.{issued}.{_sign(payload)}"


def verify_employee_token(token: Optional[str]) -> Optional[int]:
    """Return the employee id carried by a valid, unexpired token, else None."""
    raw = _strip_bearer(token)
    if not raw:
        return None
    parts = raw.split(".")
    if len(parts) != 4 or parts[0] != "emp":
        return None
    try:
        employee_id = int(parts[1])
        issued = int(parts[2])
    except ValueError:
        return None
    if not hmac.compare_digest(parts[3], _sign(f"emp:{employee_id}:{issued}")):
        return None
    if not _is_fresh(issued, EMPLOYEE_TOKEN_TTL_SECONDS):
        return None
    return employee_id


def create_admin_token(username: str) -> str:
    clean_user = username.strip().lower()
    issued = int(time.time())
    encoded_user = _b64encode(clean_user)
    payload = f"adm:{encoded_user}:{issued}"
    return f"adm.{encoded_user}.{issued}.{_sign(payload)}"


def parse_admin_token(token: Optional[str]) -> Optional[Tuple[str, int]]:
    """Return ``(username, issued_at)`` for a valid, unexpired admin token, else None."""
    raw = _strip_bearer(token)
    if not raw:
        return None
    parts = raw.split(".")
    if len(parts) != 4 or parts[0] != "adm":
        return None
    encoded_user, issued_raw, signature = parts[1], parts[2], parts[3]
    if not hmac.compare_digest(signature, _sign(f"adm:{encoded_user}:{issued_raw}")):
        return None
    try:
        issued = int(issued_raw)
    except ValueError:
        return None
    if not _is_fresh(issued, ADMIN_TOKEN_TTL_SECONDS):
        return None
    username = _b64decode(encoded_user)
    if not username:
        return None
    return username, issued
