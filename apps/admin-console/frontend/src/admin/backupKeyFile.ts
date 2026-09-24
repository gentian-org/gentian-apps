/** Saving a backup key, in the two forms that survive different disasters.
 *
 * A minted key is shown once and stored nowhere, so the moment it appears is
 * the only moment it can be kept. Everything here exists to make keeping it one
 * click rather than a copy-paste into a text editor that may never be saved.
 *
 * Two forms, because they fail differently. The text file is what a restore
 * actually consumes — `age -d -i` reads it verbatim — and it is useless if the
 * disk holding it is the one being restored. The PNG is for paper: printed and
 * put somewhere physical, it survives losing every computer, and a phone can
 * read it back. Neither is a substitute for the other.
 */
import QRCode from "qrcode";
import type { MintedKey } from "@/api/admin";

/** What goes in the .txt file.
 *
 * The identity on its own line and nothing else that could be mistaken for it,
 * because `age -d -i <file>` reads this file directly: age ignores lines
 * starting with '#', so the surrounding notes are safe to include and the file
 * works as-is without anyone having to trim it first.
 *
 * The public key is here too. Months from now, "which of these keys opens that
 * bucket" is the question, and a private key with no way to identify what it
 * belongs to is barely better than none.
 */
export function keyFileContents(key: MintedKey, tenant: string): string {
  return [
    "# Gentian backup key",
    `# Workspace : ${tenant}`,
    `# Created   : ${new Date().toISOString()}`,
    "#",
    "# The line below opens every backup encrypted to this key. Keep it offline.",
    "# Losing it makes those backups unreadable, by you and by anyone else.",
    "#",
    `# Public key (safe to share): ${key.recipient}`,
    "#",
    "# To read a backup with this file:",
    "#   age -d -i backup-key.txt manifest.json.age > manifest.json",
    "",
    key.identity,
    "",
  ].join("\n");
}

/** Hand the browser a file to save.
 *
 * An object URL rather than a data: URI — Safari refuses to download a data:
 * URI from a link click — and revoked afterwards, because the blob otherwise
 * holds the key in memory for the life of the document.
 */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function saveKeyFile(key: MintedKey, tenant: string): void {
  saveBlob(
    new Blob([keyFileContents(key, tenant)], { type: "text/plain" }),
    `gentian-backup-key-${tenant}.txt`,
  );
}

/** The identity as a QR code, for printing.
 *
 * Error correction level H — the most redundant of the four — because this is
 * meant to be printed, folded, and read years later by a phone camera at an
 * angle. A quarter of the symbol can be destroyed and it still decodes.
 *
 * Encodes the identity alone, not the annotated file: a QR carrying the whole
 * text file would be a much denser symbol for no gain, and what a phone should
 * produce when scanned is the key itself.
 */
export function qrDataUrl(key: MintedKey): Promise<string> {
  return QRCode.toDataURL(key.identity, {
    errorCorrectionLevel: "H",
    margin: 2,
    width: 512,
    color: { dark: "#000000", light: "#ffffff" },
  });
}

export async function saveKeyQr(key: MintedKey, tenant: string): Promise<void> {
  const url = await qrDataUrl(key);
  const blob = await (await fetch(url)).blob();
  saveBlob(blob, `gentian-backup-key-${tenant}.png`);
}
