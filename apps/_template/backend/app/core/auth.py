"""Who the caller is, for this app's settings: gentian_app_runtime.auth answers.

The bearer on a request is verified here and nowhere else, and nothing else
says who is asking. Under edge it is a token of the signed-in person that the
platform's front door obtained for this component alone: the session's token
exchanged at the tenant's realm for one whose audience is this component's
name (exchangeToken in the profile). Under pkce it is the bundle's own. Both
are RS256 tokens from the configured issuer and both are verified the same
way: signature against the issuer's published keys, issuer, expiry, and the
audience this component was told to require. Nothing about the mode changes
the verification, only who put the header there.

The identity headers the front door also sets are not read. A header is a
claim by whoever sent the request; a token is the realm's.

A component of platform trust may be handed the session's own token instead
(forwardToken), which is made out to the director, and relay it there (see
director.py). It then requires the director's audience. Either way this
module establishes who is asking; it grants nothing.
"""

from gentian_app_runtime.auth import bearer_of, current_user

from app.core.config import get_settings

get_current_user = current_user(get_settings)

__all__ = ["bearer_of", "get_current_user"]
