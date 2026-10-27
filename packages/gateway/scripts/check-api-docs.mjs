#!/usr/bin/env node
/**
 * Fails when a public export of `src/index.ts` has no TSDoc comment.
 * Usage: node scripts/check-api-docs.mjs   (run from packages/gateway)
 */
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const configPath = fileURLToPath(new URL('../tsconfig.build.json', import.meta.url));
const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(
  config,
  ts.sys,
  fileURLToPath(new URL('..', import.meta.url)),
);
const program = ts.createProgram([entry], parsed.options);
const checker = program.getTypeChecker();
const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(entry));

const missing = [];
for (const exp of checker.getExportsOfModule(moduleSymbol)) {
  const target = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
  const hasDoc =
    target.getDocumentationComment(checker).length > 0 ||
    (target.declarations ?? []).some((d) => ts.getJSDocCommentsAndTags(d).length > 0);
  if (!hasDoc) missing.push(exp.getName());
}
const total = checker.getExportsOfModule(moduleSymbol).length;
if (missing.length > 0) {
  console.error(
    `✖ ${missing.length}/${total} public exports have no TSDoc:\n  ${missing.sort().join('\n  ')}`,
  );
  process.exit(1);
}
console.log(`✔ all ${total} public exports have TSDoc`);
