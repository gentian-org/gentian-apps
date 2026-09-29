# Tile art

`tile.svg` is the image the portal draws for this component, and every
component ships its own. A person recognises a tile before they can read its
label, so two components drawn from one shared glyph set look like the same
thing — which is why the platform owns no set to pick from.

Start from the placeholder here if you have no idea yet. It is deliberately
plain: it reads as "not finished" at a glance, so a component that shipped
without its own art is obvious rather than quietly anonymous.

Keep it square, 52×52, and legible at 24px. Inline every colour and path; the
portal renders the whole desktop from one ConfigMap and fetches nothing per
tile, so a `<image href="…">` or an external stylesheet will not resolve.

Before you commit, inline it into the profile:

    scripts/sync-profile-tile.py <profile-dir>

That writes the base64 into `expose[].tile.logo`, which is the field the
cluster reads, and leaves `image` naming this file so a reviewer sees the real
art in the diff instead of a wall of base64.
