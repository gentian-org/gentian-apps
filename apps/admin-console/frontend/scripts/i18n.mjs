/**
 * The console's user-visible strings, lifted into a catalogue (AD-15).
 *
 *   node scripts/i18n.mjs --check    fail if a component has an inline string
 *   node scripts/i18n.mjs --apply    rewrite the components and write en.json
 *
 * Parses with the TypeScript compiler rather than matching text. A regular
 * expression cannot tell a JSX text child from the right-hand side of `a > b`
 * or from a generic's closing bracket, and on five thousand lines of TSX it
 * will eventually rewrite one of them into something that still compiles.
 *
 * WHAT IT WILL NOT DO, on purpose: an element whose children mix text with an
 * expression is left alone and reported. Splitting "Apps come from the {link}
 * and nothing else" into two keys gives a translator two fragments and no
 * sentence, and German puts the pieces in a different order — those belong in
 * <Trans>, by hand, so the sentence survives as a sentence.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";
import ts from "typescript";

const SRC = "src";
const ATTRS = new Set(["placeholder", "title", "aria-label", "alt"]);
const APPLY = process.argv.includes("--apply");

/** Files whose strings are not a person's to read. */
const SKIP = /\.(test|spec)\.tsx$/;

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else if (p.endsWith(".tsx") && !SKIP.test(p)) out.push(p);
  }
  return out;
}

/** The namespace a file's keys live under: AuditSection.tsx -> audit. */
function namespaceOf(file) {
  const n = basename(file, ".tsx").replace(/(Section|Chart|Choice)$/, "");
  return n[0].toLowerCase() + n.slice(1);
}

function keyOf(text, used) {
  const words = (text.match(/[A-Za-z0-9]+/g) || ["text"]).slice(0, 5);
  let k = words[0].toLowerCase() + words.slice(1).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join("");
  k = k.slice(0, 44) || "text";
  let candidate = k;
  for (let i = 2; used.has(candidate); i++) candidate = `${k}${i}`;
  used.add(candidate);
  return candidate;
}

const hasWords = (s) => /[A-Za-z]{2}/.test(s);

/**
 * JSX decodes `&rsquo;` when it parses the file; a catalogue string does not.
 * A value carried across as written would render the six characters
 * `&apos;` on the screen, so the entity is resolved here, once, where the
 * text leaves the syntax tree.
 */
const ENTITIES = {
  "&amp;": "&", "&apos;": "'", "&quot;": '"', "&lt;": "<", "&gt;": ">",
  "&nbsp;": "\u00a0", "&hellip;": "\u2026", "&mdash;": "\u2014", "&ndash;": "\u2013",
  "&lsquo;": "\u2018", "&rsquo;": "\u2019", "&ldquo;": "\u201c", "&rdquo;": "\u201d",
  "&middot;": "\u00b7", "&times;": "\u00d7", "&deg;": "\u00b0",
};
const decode = (s) =>
  s.replace(/&[a-zA-Z]+;|&#(\d+);/g, (m, dec) =>
    dec !== undefined ? String.fromCodePoint(Number(dec)) : (ENTITIES[m] ?? m));

/** Whitespace-only JSX text is layout, not language. */
const isBlank = (node) => node.kind === ts.SyntaxKind.JsxText && node.text.trim() === "";

/**
 * Elements whose text is not language.
 *
 * `<code>spec.catalogue.sources</code>` is a field path: the same nine
 * characters in every language, and a catalogue entry for it would invite a
 * translator to change one. Same for a shell command, a key name or a sample
 * of output.
 */
const VERBATIM = new Set(["code", "pre", "kbd", "samp", "var"]);
/** The console's monospace class means the same thing a <code> does. */
const MONO = /\bmono\b|__mono/;
const isVerbatim = (node) => {
  if (!ts.isJsxElement(node)) return false;
  if (VERBATIM.has(node.openingElement.tagName.getText())) return true;
  for (const a of node.openingElement.attributes.properties) {
    if (ts.isJsxAttribute(a) && a.name.getText() === "className" && a.initializer
        && ts.isStringLiteral(a.initializer) && MONO.test(a.initializer.text)) return true;
  }
  return false;
};

const catalogue = {};
const mixed = [];
let inlineCount = 0;

for (const file of walkFiles(SRC)) {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  const ns = namespaceOf(file);
  const used = new Set();
  const entries = {};
  const edits = [];

  const visit = (node) => {
    if (isVerbatim(node)) {
      // Not its children either: nothing inside a <code> is prose.
      return;
    }
    if (ts.isJsxElement(node)) {
      const kids = node.children.filter((c) => !isBlank(c));
      const texts = kids.filter((c) => c.kind === ts.SyntaxKind.JsxText && hasWords(c.text));
      // Whole-sentence rule. ONE run of text in an element is a complete
      // phrase however many elements sit beside it: a <label> with its input,
      // a heading with a badge. TWO runs means an expression cut a sentence
      // in half, and each half on its own is not translatable -- those are
      // the ones that go to <Trans>.
      if (texts.length === 1) {
        const t = texts[0];
        const value = decode(t.text.trim().replace(/\s+/g, " "));
        const key = keyOf(value, used);
        entries[key] = value;
        edits.push({ start: t.getStart(sf), end: t.getEnd(), text: `{t("${ns}.${key}")}` });
        inlineCount++;
      } else if (texts.length > 0) {
        mixed.push(`${relative(".", file)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${texts.map((x) => x.text.trim().replace(/\s+/g, " ")).join(" … ").slice(0, 70)}`);
        inlineCount += texts.length;
      }
    }
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const name = node.name.getText(sf);
      if (ATTRS.has(name) && hasWords(node.initializer.text)) {
        const value = decode(node.initializer.text);
        const key = keyOf(value, used);
        entries[key] = value;
        edits.push({
          start: node.initializer.getStart(sf),
          end: node.initializer.getEnd(),
          text: `{t("${ns}.${key}")}`,
        });
        inlineCount++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (Object.keys(entries).length) {
    catalogue[ns] = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
  }
  if (APPLY && edits.length) {
    let out = source;
    for (const e of edits.sort((a, b) => b.start - a.start)) {
      out = out.slice(0, e.start) + e.text + out.slice(e.end);
    }
    writeFileSync(file, out);
  }
}

const keys = Object.values(catalogue).reduce((n, v) => n + Object.keys(v).length, 0);

if (APPLY) {
  mkdirSync(join(SRC, "locales"), { recursive: true });
  writeFileSync(join(SRC, "locales", "en.json"), JSON.stringify(catalogue, null, 2) + "\n");
  console.log(`wrote src/locales/en.json — ${Object.keys(catalogue).length} namespaces, ${keys} keys`);
  console.log(`${mixed.length} element(s) mix text with an expression and need <Trans> by hand:`);
  for (const m of mixed) console.log("  " + m);
  process.exit(0);
}

/**
 * The other half of the rule: prose written as a plain string literal.
 *
 * JSX text is the obvious case and the extractor handles it. A label in a
 * module-scope array, a sentence built in a ternary, a message handed to
 * setError -- those never appear between > and < and would pass a check that
 * only looked there, which is how a screen ends up half translated.
 *
 * A string thrown to a developer is not in scope: nobody using the console
 * ever sees it, and a catalogue entry for it would invite somebody to
 * translate a bug report.
 */
const CSSISH = /^\s*[a-z0-9-]+(__|--)[a-z0-9-]+/;
const isProse = (v) => {
  const t = v.trim();
  if (t.length < 3 || !/\s/.test(t) || !/[A-Za-z]{3}/.test(t)) return false;
  if (CSSISH.test(v)) return false;
  if (/^[./]/.test(t) || t.includes("://")) return false;
  return true;
};
const SKIP_PROPS = new Set(["className", "key", "queryKey", "id", "name", "type", "href", "rel", "target", "style"]);
const thrown = (node) => {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isThrowStatement(p)) return true;
    if (ts.isNewExpression(p) && p.expression.getText().endsWith("Error")) return true;
    if (ts.isFunctionLike(p)) return false;
  }
  return false;
};

function proseLiterals(file) {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  const out = [];
  const visit = (n) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && isProse(n.text)) {
      const p = n.parent;
      const skip =
        ts.isImportDeclaration(p) ||
        ts.isJsxAttribute(p) ||
        (ts.isPropertyAssignment(p) && SKIP_PROPS.has(p.name.getText())) ||
        thrown(n);
      if (!skip) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        out.push(`${relative(".", file)}:${line} ${JSON.stringify(n.text).slice(0, 72)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// --check: the catalogue is the only place a user-visible string may live.
const catalogueFile = join(SRC, "locales", "en.json");
let known = {};
try {
  known = JSON.parse(readFileSync(catalogueFile, "utf8"));
} catch {
  console.error(`${catalogueFile} is missing — run: node scripts/i18n.mjs --apply`);
  process.exit(1);
}
const literals = walkFiles(SRC).flatMap(proseLiterals);
if (inlineCount > 0 || literals.length > 0) {
  console.error(
    `${inlineCount + literals.length} user-visible string(s) are still written inline in a component (AD-15).`,
  );
  for (const m of mixed) console.error("  " + m);
  for (const l of literals) console.error("  " + l);
  process.exit(1);
}
const missing = [];
for (const [ns, v] of Object.entries(catalogue)) {
  for (const k of Object.keys(v)) if (!known[ns]?.[k]) missing.push(`${ns}.${k}`);
}
if (missing.length) {
  console.error(`${missing.length} key(s) are used and not in en.json: ${missing.slice(0, 5).join(", ")}`);
  process.exit(1);
}

// Every other language against the source, including what a sentence carries
// inside it: a translation that dropped {{count}} renders a number nowhere,
// and one that dropped a <tag> loses the link or the code span it wrapped.
const parts = (v) => [
  ...new Set([...v.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])),
  ...new Set([...v.matchAll(/<(\w+)>/g)].map((m) => `<${m[1]}>`)),
].sort();
const gaps = [];
for (const file of readdirSync(join(SRC, "locales"))) {
  if (!file.endsWith(".json") || file === "en.json") continue;
  const lang = file.replace(/\.json$/, "");
  const other = JSON.parse(readFileSync(join(SRC, "locales", file), "utf8"));
  for (const [ns, v] of Object.entries(known)) {
    for (const [k, value] of Object.entries(v)) {
      const theirs = other[ns]?.[k];
      if (theirs === undefined) gaps.push(`${lang}: ${ns}.${k} is missing`);
      else if (parts(theirs).join("|") !== parts(value).join("|"))
        gaps.push(`${lang}: ${ns}.${k} carries ${parts(theirs).join(" ") || "nothing"}, English carries ${parts(value).join(" ")}`);
    }
  }
}
if (gaps.length) {
  console.error(`${gaps.length} translation gap(s):`);
  for (const g of gaps.slice(0, 20)) console.error("  " + g);
  process.exit(1);
}
const total = Object.values(known).reduce((n, v) => n + Object.keys(v).length, 0);
console.log(`i18n: no inline strings; ${total} key(s) in the catalogue.`);
