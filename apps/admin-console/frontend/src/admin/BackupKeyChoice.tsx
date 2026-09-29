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
import { Trans, useTranslation } from "react-i18next";

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
  const { t } = useTranslation();

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
          setMintError(t("backupKey.escrowFailed"));
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
      <legend>{t("backupKey.whoCanReadIt")}</legend>

      <div className="admin-console__choices">
        {card("platform", t("backupKey.platformKey"), t("backupKey.platformKeyBody"))}
        {card("new", t("backupKey.newKey"), t("backupKey.newKeyBody"))}
        {status?.exists
          ? card(
              "existing",
              t("backupKey.existingKey"),
              status.setBy
                ? t("backupKey.existingKeyBodyBy", { who: status.setBy })
                : t("backupKey.existingKeyBody"),
            )
          : card("existing", t("backupKey.ownKey"), t("backupKey.ownKeyBody"))}
        {passphrase && card("passphrase", t("backupKey.myPassphrase"), passphrase.body)}
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
              {t("backupKey.keepACopyInThe")}
              {status?.exists ? t("backupKey.replacesEscrowed") : ""}
            </span>
          </label>
          <p className="admin-console__hint">
            {t(keepInVault ? "backupKey.vaultKept" : "backupKey.downloadOnly")}
          </p>
          <div className="admin-console__submit">
            <button
              type="button"
              className="admin-console__btn admin-console__btn--primary"
              disabled={minting}
              onClick={generate}
            >
              {t(minting ? "backupKey.generating" : "backupKey.generateBackupKey")}
            </button>
          </div>
          {mintError && <p className="admin-console__error">{mintError}</p>}
        </div>
      )}

      {choice === "new" && minted && (
        <div className="admin-console__keycard">
          <p className="admin-console__keycard-lead">
            <strong>{t("backupKey.saveThisNow")}</strong> {t("backupKey.itIsShownOnceWithout")}</p>
          <div className="admin-console__keycard-body">
            {qr && (
              <img
                className="admin-console__keycard-qr"
                src={qr}
                alt={t("backupKey.yourBackupKeyAsA")}
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
                {t("backupKey.saveKeyFile")}</button>
              <button
                type="button"
                className="admin-console__btn"
                onClick={() => void saveKeyQr(minted, tenant)}
              >
                {t("backupKey.saveQrAsPng")}</button>
            </div>
          </div>
          {mintError && <p className="admin-console__error">{mintError}</p>}
        </div>
      )}

      {choice === "existing" && (
        <div className="admin-console__stack">
          {status?.exists && status.recipient && !pasted && (
            <p className="admin-console__hint">
              {t("backupKey.using")}<code className="admin-console__wrap">{status.recipient}</code>
            </p>
          )}
          {status?.exists && !status.recipient && (
            <p className="admin-console__warning">
              {t("backupKey.aKeyIsEscrowedFor")}</p>
          )}
          <label className="admin-console__label">
            <span className="admin-console__label-text">
              {t(status?.exists ? "backupKey.orADifferentKey" : "backupKey.yourPublicKey")}
            </span>
            <textarea
              rows={2}
              spellCheck={false}
              placeholder={t("backupKey.age1")}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
            />
            <span className="admin-console__hint">
              <Trans i18nKey="backupKey.pasteHint" components={{ code: <code /> }} />
            </span>
          </label>
        </div>
      )}
    </fieldset>
  );
}
