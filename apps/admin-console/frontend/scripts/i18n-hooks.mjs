/**
 * Give every component that now calls t() the hook that provides it.
 *
 * A one-off companion to i18n.mjs, kept because re-running the extraction on a
 * new batch of screens wants the same pass. Parses with the TypeScript
 * compiler for the same reason: knowing whether a `t(` sits inside a React
 * component or inside a plain helper is a question about the syntax tree, and
 * getting it wrong produces a hook called conditionally, which React only
 * complains about at runtime.
 *
 * A function whose name starts with a capital is a component and gets the
 * hook. Anything else that calls t() is reported instead — a helper cannot
 * hold a hook, so it has to take its text as an argument.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const SRC = "src";

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const callsT = (node, sf) => {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "t") found = true;
    else ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return found;
};

const stray = [];

for (const file of walkFiles(SRC)) {
  const source = readFileSync(file, "utf8");
  if (!/\bt\(["']/.test(source)) continue;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  const inserts = [];

  /** A body that already declares t needs nothing: this pass is re-run. */
  const declaresT = (body) =>
    body.statements.some(
      (st) =>
        ts.isVariableStatement(st) &&
        st.declarationList.declarations.some((d) => /\bt\b/.test(d.name.getText(sf)) &&
          d.initializer && /useTranslation\(/.test(d.initializer.getText(sf))),
    );

  const consider = (name, body) => {
    if (!body || !ts.isBlock(body) || !callsT(body, sf)) return;
    if (declaresT(body)) return;
    if (!/^[A-Z]/.test(name)) {
      stray.push(`${relative(".", file)}: ${name}() calls t() and is not a component`);
      return;
    }
    // After the opening brace, as the first statement: a hook must run on
    // every render, so it cannot sit below an early return.
    inserts.push(body.getStart(sf) + 1);
  };

  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) consider(node.name.text, node.body);
    else if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) consider(node.name.text, init.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (!inserts.length) continue;
  let out = source;
  for (const at of inserts.sort((a, b) => b - a)) {
    out = out.slice(0, at) + "\n  const { t } = useTranslation();\n" + out.slice(at);
  }
  if (!/from "react-i18next"/.test(out)) {
    // After the last import, so the import block stays one block.
    const sf2 = ts.createSourceFile(file, out, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
    const imports = sf2.statements.filter(ts.isImportDeclaration);
    const at = imports.length ? imports[imports.length - 1].getEnd() : 0;
    out = out.slice(0, at) + '\nimport { useTranslation } from "react-i18next";' + out.slice(at);
  }
  writeFileSync(file, out);
}

for (const s of stray) console.log("  " + s);
console.log(stray.length ? `${stray.length} helper(s) need their text passed in.` : "every t() is inside a component.");
