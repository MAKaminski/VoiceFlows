/**
 * Code map from the TypeScript AST (compiler API, no heuristics).
 *   pnpm codemap          → writes docs/CODEMAP.md
 *   pnpm codemap --check  → exit 1 if docs/CODEMAP.md is stale (CI gate)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "docs/CODEMAP.md");
const PROJECTS = [
  { name: "@livecanvas/dsl", dir: "packages/dsl/src", layer: "Middleware (shared contracts)" },
  { name: "@livecanvas/prompts", dir: "packages/prompts/src", layer: "Middleware" },
  { name: "@livecanvas/gateway", dir: "apps/gateway/src", layer: "Middleware" },
  { name: "@livecanvas/web", dir: "apps/web", layer: "Front-end" },
];

interface Sym { name: string; kind: string; line: number; exported: boolean }
interface Mod { file: string; project: string; loc: number; symbols: Sym[]; imports: string[] }

const walkFiles = (dir: string): string[] =>
  ts.sys.readDirectory(resolve(ROOT, dir), [".ts", ".tsx"], ["**/node_modules/**", "**/.next/**", "**/*.d.ts"]);

const kindOf = (n: ts.Node): string | null => {
  if (ts.isFunctionDeclaration(n)) return "function";
  if (ts.isClassDeclaration(n)) return "class";
  if (ts.isInterfaceDeclaration(n)) return "interface";
  if (ts.isTypeAliasDeclaration(n)) return "type";
  if (ts.isEnumDeclaration(n)) return "enum";
  if (ts.isVariableStatement(n)) return "const";
  return null;
};

function parse(file: string, project: string): Mod {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const symbols: Sym[] = [];
  const imports: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) || (ts.isExportDeclaration(st) && st.moduleSpecifier)) {
      const spec = (st.moduleSpecifier as ts.StringLiteral).text;
      imports.push(spec);
      continue;
    }
    const kind = kindOf(st);
    if (!kind) continue;
    const exported = !!ts.getModifiers(st as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const line = sf.getLineAndCharacterOfPosition(st.getStart()).line + 1;
    const names = ts.isVariableStatement(st)
      ? st.declarationList.declarations.map((d) => d.name.getText(sf))
      : [((st as ts.DeclarationStatement).name?.getText(sf)) ?? "default"];
    for (const name of names) symbols.push({ name, kind, line, exported });
  }
  return { file: relative(ROOT, file), project, loc: text.split("\n").length, symbols, imports };
}

const mods = PROJECTS.flatMap((p) => walkFiles(p.dir).sort().map((f) => parse(f, p.name)));

// Resolve relative + workspace imports to module/package edges.
const byFile = new Map(mods.map((m) => [m.file, m]));
const resolveImport = (from: string, spec: string): string | null => {
  if (spec.startsWith("@livecanvas/")) return spec;
  if (spec.startsWith("@/")) spec = relative(dirname(resolve(ROOT, from)), resolve(ROOT, "apps/web", spec.slice(2))) || ".";
  if (!spec.startsWith(".")) return null; // external dep
  const base = resolve(ROOT, dirname(from), spec).replace(/\.js$/, "");
  for (const ext of [".ts", ".tsx", "/index.ts"]) {
    const rel = relative(ROOT, base + ext);
    if (byFile.has(rel)) return rel;
  }
  return null;
};

const pkgEdges = new Set<string>();
const extDeps = new Map<string, Set<string>>();
for (const m of mods) {
  for (const spec of m.imports) {
    const r = resolveImport(m.file, spec);
    if (r?.startsWith("@livecanvas/") && r !== m.project) pkgEdges.add(`${m.project}|${r}`);
    if (!r && !spec.startsWith(".")) {
      const dep = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
      if (!dep.startsWith("node:")) (extDeps.get(m.project) ?? extDeps.set(m.project, new Set()).get(m.project)!).add(dep);
    }
  }
}

const id = (s: string) => s.replace(/[^A-Za-z0-9]/g, "_");
const exportedCount = mods.reduce((n, m) => n + m.symbols.filter((s) => s.exported).length, 0);
const dupes = (() => {
  // Same-module const+type pairs (the zod `X` schema + `type X`) are one idea, not a duplicate.
  const seen = new Map<string, Set<string>>();
  for (const m of mods) for (const s of m.symbols.filter((x) => x.exported)) (seen.get(s.name) ?? seen.set(s.name, new Set()).get(s.name)!).add(m.file);
  return [...seen].filter(([, f]) => f.size > 1).map(([n, f]) => [n, [...f]] as const);
})();

let md = `# Code map\n\n_Generated from the TypeScript AST by \`pnpm codemap\` — do not edit by hand; CI runs \`pnpm codemap --check\`._\n\n`;
md += `| Measure | Count |\n|---|---|\n| Modules | ${mods.length} |\n| Lines | ${mods.reduce((n, m) => n + m.loc, 0)} |\n| Top-level symbols | ${mods.reduce((n, m) => n + m.symbols.length, 0)} |\n| Exported symbols | ${exportedCount} |\n| Exported names defined in 2+ modules | ${dupes.length} |\n\n`;
md += `## Package dependency graph\n\n\`\`\`mermaid\nflowchart LR\n`;
for (const p of PROJECTS) md += `  ${id(p.name)}["${p.name}<br/><small>${p.layer}</small>"]\n`;
for (const e of [...pkgEdges].sort()) { const [a, b] = e.split("|"); md += `  ${id(a!)} --> ${id(b!)}\n`; }
md += `\`\`\`\n\n| Package | External runtime imports |\n|---|---|\n`;
for (const p of PROJECTS) md += `| ${p.name} | ${[...(extDeps.get(p.name) ?? [])].sort().map((d) => `\`${d}\``).join(", ") || "—"} |\n`;
md += `\n## Modules and exported symbols\n`;
for (const p of PROJECTS) {
  md += `\n### ${p.name} — ${p.layer}\n\n| Module | LOC | Exports (kind) |\n|---|---|---|\n`;
  for (const m of mods.filter((x) => x.project === p.name)) {
    const ex = m.symbols.filter((s) => s.exported).map((s) => `\`${s.name}\` ${s.kind}`).join(" · ") || "—";
    md += `| [${m.file.replace(p.dir + "/", "")}](../${m.file}) | ${m.loc} | ${ex} |\n`;
  }
}
if (dupes.length) md += `\n## Duplicate exported names\n\n${dupes.map(([n, f]) => `- \`${n}\`: ${f.join(", ")}`).join("\n")}\n`;

if (process.argv.includes("--check")) {
  const cur = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (cur !== md) { console.error("docs/CODEMAP.md is stale — run `pnpm codemap`"); process.exit(1); }
  console.log("codemap up to date");
} else {
  writeFileSync(OUT, md);
  console.log(`wrote docs/CODEMAP.md — ${mods.length} modules, ${exportedCount} exported symbols`);
}
