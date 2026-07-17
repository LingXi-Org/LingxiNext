from app.security import TokenCipher, hash_password, mask_secret, verify_password


def test_password_hash_is_one_way_and_verifies() -> None:
    encoded = hash_password("a-very-long-password")
    assert "a-very-long-password" not in encoded
    assert verify_password(encoded, "a-very-long-password")
    assert not verify_password(encoded, "wrong-password")


def test_token_cipher_roundtrip_and_masking() -> None:
    cipher = TokenCipher("independent-master-key-with-enough-entropy")
    encrypted = cipher.encrypt("service-token-123456789")
    assert b"service-token" not in encrypted
    assert cipher.decrypt(encrypted) == "service-token-123456789"
    assert mask_secret("service-token-123456789") == "serv••••6789"
