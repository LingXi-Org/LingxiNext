from __future__ import annotations

import os

os.environ.setdefault("CHAINLIT_AUTH_SECRET", "test-chainlit-secret-0123456789abcdef")
os.environ.setdefault("LINGXI_MASTER_KEY", "test-master-secret-0123456789abcdef0")
os.environ.setdefault("LINGXI_ADMIN_PASSWORD", "correct-horse-battery-staple")
os.environ.setdefault(
    "DATABASE_URL", "postgresql+asyncpg://lingxinext:lingxinext@localhost:5432/lingxinext"
)
os.environ.setdefault(
    "LINGXIGRAPH_POSTGRES_URL", "postgresql://lingxinext:lingxinext@localhost:5432/lingxinext"
)
