/** Who can read a backup — the one control shared by every form that makes one.
 *
 * Three answers, because there are three, and the earlier two-way version made
 * the third look like a variant of "your own key" when it is the common case:
 * a workspace that already has a key wants that key again, not a new one every
 * time it takes a backup.
 *
 * The same radio-card pattern as the destination selector above it, so a form
 * asking two questions asks them the same way.
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  escrowBackupKey,
  fetchBackupKeyStatus,
  mintBackupKey,
  type BackupKeyStatus,
  type MintedKey,
} from "@/api/admin";
import { qrDataUrl, saveKeyFile, saveKeyQr } from "@/admin/backupKeyFile";

/** "passphrase" only appears where a human is present to type one — a schedule
 * has nobody at 03:00, so its form does not offer it. */
export type KeyChoice = "platform" | "new" | "existing" | "passphrase";

/** What the caller needs to build a request: the recipients, and whether the
 * choice is finished enough to submit. */
export type KeyDecision = {
  choice: KeyChoice;
  recipients: string[];
  ready: boolean;
};

export function useBackupKeyStatus(tenant: string) {
  const [status, setStatus] = useState<BackupKeyStatus | null>(null);
  useEffect(() => {
    let live = true;
    fetchBackupKeyStatus().then(
      (s) => live && setStatus(s),
      // A workspace with no key, or a credential manager that is not reachable,
      // both mean "cannot offer the existing key" — not an error worth showing
      // in front of a backup form.
      () => live && setStatus({ exists: false, recipient: "", setBy: "", updatedAt: "" }),
    );
    return () => {
      live = false;
    };
  }, [tenant]);
  return status;
}

export function BackupKeyChoice({
  tenant,
  choice,
  onChoiceChange,
  onDecision,
  idPrefix,
  passphrase,
}: {
  tenant: string;
  choice: KeyChoice;
  onChoiceChange: (next: KeyChoice) => void;
  onDecision: (d: KeyDecision) => void;
  /** Radio groups must not collide when two forms are open on one page. */
  idPrefix: string;
  /** The passphrase card and its inputs, for forms that offer that mode.
   * Supplied by the caller because the passphrase itself never belongs to this
   * control — it goes in a Secret, not in a recipients list. */
  passphrase?: { body: string; fields: ReactNode; ready: boolean };
}) {
  const status = useBackupKeyStatus(tenant);
  const [minted, setMinted] = useState<MintedKey | null>(null);
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const [keepInVault, setKeepInVault] = useState(true);
  const [qr, setQr] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");

  useEffect(() => {
    if (!minted) {
      setQr(null);
      return;
    }
    let live = true;
    qrDataUrl(minted).then(
      (u) => live && setQr(u),
      () => live && setQr(null),
    );
    return () => {
      live = false;
    };
  }, [minted]);

  // Everything the parent needs, derived in one place so a form cannot disagree
  // with the control about what was chosen.
  useEffect(() => {
    if (choice === "platform") {
      onDecision({ choice, recipients: [], ready: true });
      return;
    }
    if (choice === "passphrase") {
      onDecision({ choice, recipients: [], ready: passphrase?.ready ?? false });
      return;
    }
    if (choice === "new") {
      const r = minted ? [minted.recipient] : [];
      onDecision({ choice, recipients: r, ready: r.length > 0 });
      return;
    }
    const typed = pasted.trim();
    const r = typed ? [typed] : status?.recipient ? [status.recipient] : [];
    onDecision({ choice, recipients: r, ready: r.length > 0 });
  }, [choice, minted, pasted, status, passphrase?.ready, onDecision]);

  const generate = async () => {
    setMinting(true);
    setMintError(null);
    try {
      const key = await mintBackupKey(tenant);
      if (keepInVault) {
        // A failed escrow is not a failed mint: the key exists either way, and
        // the card says which of the two happened.
        try {
          await escrowBackupKey(key.identity, key.recipient);
        } catch {
          setMintError("The key was generated but could not be kept in the vault — save the file.");
        }
      }
      setMinted(key);
    } catch (err) {
      setMintError((err as Error).message);
    } finally {
      setMinting(false);
    }
  };

  const card = (value: KeyChoice, title: string, body: string) => (
    <label
      className={`admin-console__choice${choice === value ? " admin-console__choice--selected" : ""}`}
    >
      <input
        type="radio"
        name={`${idPrefix}-key`}
        checked={choice === value}
        onChange={() => onChoiceChange(value)}
      />
      <span>
        <span className="admin-console__choice-title">{title}</span>
        <span className="admin-console__choice-desc">{body}</span>
      </span>
    </label>
  );

  return (
    <fieldset className="admin-console__fieldset admin-console__fieldset--plain">
      <legend>Who can read it</legend>

      <div className="admin-console__choices">
        {card(
          "platform",
          "The platform's key",
          "Your provider can open the backup, so they can help you restore it. The right choice unless you have a reason otherwise.",
        )}
        {card(
          "new",
          "A new key for this workspace",
          "Generated now and shown once. Nobody here can read the backup, including your provider — restoring is yours alone to do.",
        )}
        {status?.exists
          ? card(
              "existing",
              "The key this workspace already has",
              `Escrowed${status.setBy ? ` by ${status.setBy}` : ""}. Use it again so one key opens every backup this workspace makes.`,
            )
          : card(
              "existing",
              "A key I already have",
              "Paste the public half of a key you hold. Nothing here ever sees the private one.",
            )}
        {passphrase && card("passphrase", "My passphrase", passphrase.body)}
      </div>

      {choice === "passphrase" && passphrase && (
        <div className="admin-console__stack admin-console__stack--indent">{passphrase.fields}</div>
      )}

      {choice === "new" && !minted && (
        <div className="admin-console__stack">
          <label className="admin-console__checkbox">
            <input
              type="checkbox"
              checked={keepInVault}
              onChange={(e) => setKeepInVault(e.target.checked)}
            />
            <span>
              Keep a copy in the vault
              {status?.exists ? " — this replaces the key escrowed now" : ""}
            </span>
          </label>
          <p className="admin-console__hint">
            {keepInVault
              ? "You can restore without the downloaded file. A workspace administrator can read the key; the platform cannot."
              : "The download is the only copy. Lose it and these backups are unreadable by anyone."}
          </p>
          <div className="admin-console__submit">
            <button
              type="button"
              className="admin-console__btn admin-console__btn--primary"
              disabled={minting}
              onClick={generate}
            >
              {minting ? "Generating…" : "Generate backup key"}
            </button>
          </div>
          {mintError && <p className="admin-console__error">{mintError}</p>}
        </div>
      )}

      {choice === "new" && minted && (
        <div className="admin-console__keycard">
          <p className="admin-console__keycard-lead">
            <strong>Save this now.</strong> It is shown once. Without it these backups cannot be
            opened by anyone, including you.
          </p>
          <div className="admin-console__keycard-body">
            {qr && (
              <img
                className="admin-console__keycard-qr"
                src={qr}
                alt="Your backup key as a QR code, for printing"
                width={160}
                height={160}
              />
            )}
            <div className="admin-console__submit admin-console__submit--stack">
              <button
                type="button"
                className="admin-console__btn admin-console__btn--primary"
                onClick={() => saveKeyFile(minted, tenant)}
              >
                Save key file
              </button>
              <button
                type="button"
                className="admin-console__btn"
                onClick={() => void saveKeyQr(minted, tenant)}
              >
                Save QR as PNG
              </button>
            </div>
          </div>
          {mintError && <p className="admin-console__error">{mintError}</p>}
        </div>
      )}

      {choice === "existing" && (
        <div className="admin-console__stack">
          {status?.exists && status.recipient && !pasted && (
            <p className="admin-console__hint">
              Using <code className="admin-console__wrap">{status.recipient}</code>
            </p>
          )}
          {status?.exists && !status.recipient && (
            <p className="admin-console__warning">
              A key is escrowed for this workspace, but its public half was not recorded, so it
              cannot be reused here. Paste it below, or generate a new key.
            </p>
          )}
          <label className="admin-console__label">
            <span className="admin-console__label-text">
              {status?.exists ? "Or use a different public key" : "Your public key"}
            </span>
            <textarea
              rows={2}
              spellCheck={false}
              placeholder="age1…"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
            />
            <span className="admin-console__hint">
              The <code>age1</code> line from <code>age-keygen</code>. Leave empty to keep using the
              escrowed key.
            </span>
          </label>
        </div>
      )}
    </fieldset>
  );
}
