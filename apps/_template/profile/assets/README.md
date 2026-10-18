# Tile

`tile.png` is the image the portal draws for this component: a 128×128 PNG.
The one here is the default every component starts from, a platform glyph on
the neutral square. Every default tile is drawn the same way, so it reads as a
tile, not as anybody's logo; the app's own logo is shown by the App Store.

Pick the glyph that says what the component is and draw it:

    scripts/render-default-tile.py --list
    scripts/render-default-tile.py <glyph> <profile-dir>/assets/tile.png

Then inline it into the profile before you commit:

    scripts/sync-profile-tile.py <profile-dir>

That writes the base64 into `expose[].tile.logo`, which is the field the
cluster reads (a `data:image/png` URI of at most 65536 characters), and leaves
`image` naming this file so a reviewer sees the real picture in the diff
instead of a wall of base64.
