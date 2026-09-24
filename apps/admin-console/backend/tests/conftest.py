"""Test environment.

Every test passes its own Settings explicitly, in environment-variable
spelling, because a Settings built from keyword arguments in field spelling
silently ignores them and the process environment wins. The variables here
are only what a test that never constructs Settings would otherwise inherit.
"""

import os

os.environ.setdefault("AUTH_DISABLED", "true")
os.environ.setdefault("ENVIRONMENT", "local")
