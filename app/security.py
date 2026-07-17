from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
from dataclasses import dataclass

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from chainlit.auth.cookie import get_token_from_cookies
from chainlit.auth.jwt import decode_jwt
from cryptography.fernet import Fernet
from fastapi import HTTPException, Request, status

from .config import get_settings

password_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return password_hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return password_hasher.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


class TokenCipher:
    def __init__(self, secret: str) -> None:
        key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode("utf-8")).digest())
        self._fernet = Fernet(key)

    def encrypt(self, value: str) -> bytes:
        return self._fernet.encrypt(value.encode("utf-8"))

    def decrypt(self, value: bytes) -> str:
        return self._fernet.decrypt(value).decode("utf-8")


def token_cipher() -> TokenCipher:
    return TokenCipher(get_settings().lingxi_master_key.get_secret_value())


def mask_secret(value: str) -> str:
    if len(value) <= 8:
        return "••••••••"
    return f"{value[:4]}••••{value[-4:]}"


@dataclass(frozen=True, slots=True)
class AuthenticatedUser:
    username: str
    role: str


def current_user(request: Request) -> AuthenticatedUser:
    token = get_token_from_cookies(request.cookies)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="not_authenticated")
    try:
        user = decode_jwt(token)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_session"
        ) from exc
    return AuthenticatedUser(user.identifier, str((user.metadata or {}).get("role", "user")))


def require_admin(request: Request) -> AuthenticatedUser:
    user = current_user(request)
    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="admin_required")
    return user


def csrf_token(request: Request) -> str:
    auth = get_token_from_cookies(request.cookies) or "anonymous"
    secret = get_settings().chainlit_auth_secret.get_secret_value().encode("utf-8")
    return hmac.new(secret, auth.encode("utf-8"), hashlib.sha256).hexdigest()


def require_csrf(request: Request) -> None:
    expected = csrf_token(request)
    supplied = request.headers.get("x-csrf-token", "")
    if not supplied or not secrets.compare_digest(expected, supplied):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="invalid_csrf_token")
