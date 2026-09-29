import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

/**
 * The console's own words, in the viewer's language (AD-15).
 *
 * The same arrangement as the desktop's `src/lib/i18n.ts` in gentian-ui, and
 * deliberately the same rather than a second design: an operator moves between
 * the two in one session, and a platform that agreed with itself about
 * everything except how it picks a language would be the odd one out in the
 * only place a person notices.
 *
 * **Adding a language is one file.** Drop `src/locales/<code>.json` in, copy
 * the keys from `en.json`, translate them. Nothing here is edited: the
 * catalogues are discovered at build time by the glob below, and the language
 * list and the detector derive from what was found. That is the whole reason
 * the catalogues are JSON rather than TypeScript — a translator needs no
 * toolchain, and the files go to a translation service and come back without
 * anybody touching code.
 *
 * English is the fallback because it is the language the source strings are
 * written in. A key missing from a translation renders the English sentence
 * the author wrote, never a blank and never the key itself, so a language is
 * shippable while it is still half translated.
 */

// Every catalogue in src/locales. eager so they are in the bundle: this is an
// administrative console behind a sign-in, the strings are a few kilobytes,
// and a language that arrives one network round trip after the page does is a
// flash of English on every load.
const modules = import.meta.glob<{ default: Record<string, unknown> }>("../locales/*.json", {
  eager: true,
});

const resources: Record<string, { translation: Record<string, unknown> }> = {};
for (const [path, module] of Object.entries(modules)) {
  const code = path.split("/").pop()?.replace(/\.json$/, "");
  if (code) resources[code] = { translation: module.default };
}

/** The languages this build ships, in a stable order. */
export const languages: readonly string[] = Object.keys(resources).sort();

/** The language the source strings are written in, and the last fallback. */
export const fallbackLanguage = "en";

/**
 * The key the desktop stores an explicit choice under.
 *
 * The same key as gentian-ui, on purpose. The console and the desktop are
 * served from different hosts in the same zone, so this is not one shared
 * value — it is the same NAME in each origin's storage, which is what makes
 * the console honour a language chosen in the desktop's settings the first
 * time it is opened on that machine. The account remains the source of truth;
 * this is the first-paint cache, and the desktop is where the choice is made.
 */
export const languageStorageKey = "gentian.language";

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    supportedLngs: languages as string[],
    fallbackLng: fallbackLanguage,
    // de-CH and de-AT are served the German catalogue. Falling back ACROSS
    // languages is what never happens: an unmatched language gets English,
    // which is the author's own words rather than a guess.
    nonExplicitSupportedLngs: true,
    load: "languageOnly",
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: languageStorageKey,
      caches: ["localStorage"],
    },
    interpolation: {
      // React escapes what it renders; doing it twice turns an apostrophe
      // into &#39; on the screen.
      escapeValue: false,
    },
    returnNull: false,
  });

export default i18n;
