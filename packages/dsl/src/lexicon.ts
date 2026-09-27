import type { DesignDoc, DesignNode } from "./doc.js";
import type { PatchOp } from "./ops.js";
import type { PrimitiveType } from "./primitives.js";

/**
 * Lexicon tier (ADR 0001, runs in the gateway per ADR 0009): turns the running transcript of an
 * utterance into provisional nodes with no model call, so the first visible change lands ~5 ms
 * after the STT partial. Pure and stateless — recomputed from the full running text each time:
 *  - nouns create a node only if no node of the same *kind key* exists anywhere in the doc, so
 *    repeated partials, second mentions and "make the email field bigger" never duplicate;
 *  - "the/this/that/its <noun>" refers to an existing element: never creates when that type exists;
 *  - modifiers (big / blue / …) are held until the next noun;
 *  - nodes are inserted into root by type rank (Nav < Image < Text < Input < containers < Icon <
 *    Button), so "logo on top" said last still lands above the form once, not append-then-move;
 *  - ids are `n_p_<alias>`, flagged `provisional: true` until the model touches them.
 */

export interface LexiconResult {
  ops: PatchOp[];
  created: Array<{ id: string; word: string; kind: string }>;
  /** Occurrence keys (`button#1` = first "button" in the utterance) this call turned into nodes —
   *  nouns plus the modifiers attached to them. Stable under Flux revisions ("sign and" → "sign in"). */
  consumed: string[];
}

/** `word#k` for each token: the k-th occurrence of that word in the text (1-based). */
export function occurrenceKeys(words: string[]): string[] {
  const seen = new Map<string, number>();
  return words.map((w) => { const k = (seen.get(w) ?? 0) + 1; seen.set(w, k); return `${w}#${k}`; });
}

const RANK: Partial<Record<PrimitiveType, number>> = { Nav: 0, Image: 1, Text: 2, Input: 3, Card: 4, List: 4, Table: 4, Chart: 4, Stack: 4, Icon: 5, Button: 6 };
const rank = (t: PrimitiveType) => RANK[t] ?? 4;

const SIZE: Record<string, string> = { big: "lg", large: "lg", huge: "lg", small: "sm", tiny: "sm" };
const COLOR: Record<string, string> = { blue: "primary", purple: "secondary", red: "danger", gray: "muted", grey: "muted", white: "surface", black: "text", dark: "text" };
const SCREEN_TITLES: Array<[string[], string]> = [
  [["log", "in"], "Log in"], [["login"], "Log in"], [["sign", "in"], "Sign in"], [["sign", "up"], "Sign up"], [["signup"], "Sign up"],
  [["register"], "Create account"], [["registration"], "Create account"], [["settings"], "Settings"], [["profile"], "Profile"],
  [["checkout"], "Checkout"], [["home"], "Home"], [["dashboard"], "Dashboard"], [["welcome"], "Welcome"], [["onboarding"], "Welcome"],
  [["search"], "Search"], [["cart"], "Your cart"],
];
const BUTTON_LABELS: Array<[string[], string]> = [
  [["sign", "in"], "Sign in"], [["log", "in"], "Log in"], [["login"], "Log in"], [["sign", "up"], "Sign up"],
  [["signup"], "Sign up"], [["get", "started"], "Get started"], [["submit"], "Submit"], [["continue"], "Continue"],
  [["next"], "Next"], [["save"], "Save"], [["send"], "Send"], [["buy"], "Buy"], [["checkout"], "Checkout"],
];

type Mods = { size?: string; color?: string };
const phraseBefore = (words: string[], i: number, table: Array<[string[], string]>) => {
  for (const [phrase, text] of table) {
    const start = i - phrase.length;
    if (start >= 0 && phrase.every((w, k) => words[start + k] === w)) return text;
  }
  return null;
};
interface NounSpec { alias: string; type: PrimitiveType; props: (mods: Mods, words: string[], i: number) => Record<string, unknown>; children?: boolean }

const NOUNS: Record<string, NounSpec> = {
  email: { alias: "email", type: "Input", props: () => ({ label: "Email", kind: "email", placeholder: "you@example.com" }) },
  password: { alias: "password", type: "Input", props: () => ({ label: "Password", kind: "password" }) },
  username: { alias: "username", type: "Input", props: () => ({ label: "Username", kind: "text" }) },
  logo: { alias: "logo", type: "Image", props: () => ({ alt: "Logo", aspect: "3:1" }) },
  image: { alias: "image", type: "Image", props: () => ({ alt: "Image", aspect: "16:9" }) },
  photo: { alias: "photo", type: "Image", props: () => ({ alt: "Photo", aspect: "16:9" }) },
  picture: { alias: "picture", type: "Image", props: () => ({ alt: "Picture", aspect: "16:9" }) },
  avatar: { alias: "avatar", type: "Image", props: () => ({ alt: "Avatar", aspect: "1:1", radius: "full" }) },
  title: { alias: "title", type: "Text", props: () => ({ content: "Title", variant: "title" }) },
  heading: { alias: "title", type: "Text", props: () => ({ content: "Title", variant: "title" }) },
  headline: { alias: "title", type: "Text", props: () => ({ content: "Title", variant: "title" }) },
  icon: { alias: "icon", type: "Icon", props: (m) => ({ name: "star", ...(m.size ? { size: m.size } : {}), ...(m.color ? { color: m.color } : {}) }) },
  card: { alias: "card", type: "Card", props: () => ({ padding: "md", elevation: 1 }), children: true },
  list: { alias: "list", type: "List", props: () => ({ items: [{ title: "Item one" }, { title: "Item two" }, { title: "Item three" }] }) },
  nav: { alias: "nav", type: "Nav", props: () => ({ items: ["Home", "Search", "Profile"], position: "bottom" }) },
  navigation: { alias: "nav", type: "Nav", props: () => ({ items: ["Home", "Search", "Profile"], position: "bottom" }) },
  menu: { alias: "nav", type: "Nav", props: () => ({ items: ["Home", "Search", "Profile"], position: "top" }) },
  table: { alias: "table", type: "Table", props: () => ({ columns: ["Name", "Value"], rows: [["—", "—"]] }) },
  chart: { alias: "chart", type: "Chart", props: () => ({ kind: "bar", series: [3, 5, 2, 6] }) },
  graph: { alias: "chart", type: "Chart", props: () => ({ kind: "line", series: [3, 5, 2, 6] }) },
  // "a login screen" / "the settings page" → the screen's title (drawn first, so the model's title folds into it).
  screen: { alias: "title", type: "Text", props: (_m, words, i) => ({ content: phraseBefore(words, i, SCREEN_TITLES) ?? "", variant: "title" }) },
  page: { alias: "title", type: "Text", props: (_m, words, i) => ({ content: phraseBefore(words, i, SCREEN_TITLES) ?? "", variant: "title" }) },
  button: {
    alias: "button", type: "Button",
    props: (m, words, i) => {
      let label = "Button";
      for (const [phrase, text] of BUTTON_LABELS) {
        const start = i - phrase.length;
        if (start >= 0 && phrase.every((w, k) => words[start + k] === w)) { label = text; break; }
      }
      return { label, variant: "primary", ...(m.size ? { size: m.size } : {}), ...(m.color ? { color: m.color } : {}) };
    },
  },
};

/** Size/colour words the lexicon holds until the next noun ("big blue … button"). */
export const isModifier = (w: string) => w in SIZE || w in COLOR;

export const lexTokens = (t: string) => t.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter(Boolean);

/** Kind key used for dedupe (lexicon vs doc, and model adds vs provisional nodes). */
export function kindKey(n: Pick<DesignNode, "type" | "props">): string {
  const p = n.props as Record<string, unknown>;
  switch (n.type) {
    case "Input": return `Input:${p.kind ?? "text"}`;
    case "Image": return `Image:${String(p.alt ?? "").toLowerCase()}`;
    case "Button": return `Button:${String(p.label ?? "").toLowerCase()}`;
    case "Text": return `Text:${p.variant === "title" || p.variant === "display" ? "title" : String(p.content ?? "").toLowerCase()}`;
    default: return n.type;
  }
}

function collectKinds(n: DesignNode, out = new Set<string>()): Set<string> {
  out.add(kindKey(n));
  out.add(`type:${n.type}`);
  n.children?.forEach((c) => collectKinds(c, out));
  return out;
}

const DEFINITE = new Set(["the", "this", "that", "its", "your", "my"]);
/** A definite article within the 3 words before the noun ("the sign in button") marks a reference. */
const isReference = (words: string[], i: number) => words.slice(Math.max(0, i - 3), i).some((w) => DEFINITE.has(w));

/**
 * `drawn`: occurrence keys already turned into nodes earlier in this utterance — never drawn again,
 * even if the transcript was revised so the label or kind now reads differently.
 */
export function lexicon(runningText: string, doc: DesignDoc, drawn: ReadonlySet<string> = new Set()): LexiconResult {
  const words = lexTokens(runningText);
  const occ = occurrenceKeys(words);
  const kinds = collectKinds(doc.root);
  const ids = new Set<string>();
  const walk = (n: DesignNode) => { ids.add(n.id); n.children?.forEach(walk); };
  walk(doc.root);

  const ops: PatchOp[] = [];
  const created: LexiconResult["created"] = [];
  let rootKids = [...(doc.root.children ?? [])];
  const consumed: string[] = [];
  let mods: Mods = {};
  let modIdx: number[] = [];
  words.forEach((w, i) => {
    if (SIZE[w]) { mods.size = SIZE[w]; modIdx.push(i); return; }
    if (COLOR[w]) { mods.color = COLOR[w]; modIdx.push(i); return; }
    const spec = NOUNS[w];
    if (!spec) return;
    if (drawn.has(occ[i]!)) { mods = {}; modIdx = []; return; }
    const props = spec.props(mods, words, i);
    if (spec.type === "Text" && !props.content) return; // "a screen" with no recognisable name → no title
    const usedMods = modIdx;
    mods = {}; modIdx = [];
    const node: DesignNode = { id: "", type: spec.type, props, provisional: true, ...(spec.children ? { children: [] } : {}) };
    const key = kindKey(node);
    if (kinds.has(key) || (isReference(words, i) && kinds.has(`type:${spec.type}`))) return;
    let id = `n_p_${spec.alias}`, k = 2;
    while (ids.has(id)) id = `n_p_${spec.alias}_${k++}`;
    node.id = id;
    const index = rootKids.filter((c) => rank(c.type) <= rank(spec.type)).length;
    ops.push({ op: "add", path: `/root/children/${index}`, value: node });
    rootKids.splice(index, 0, node);
    kinds.add(key); kinds.add(`type:${spec.type}`); ids.add(id);
    created.push({ id, word: w, kind: key });
    consumed.push(occ[i]!, ...usedMods.map((j) => occ[j]!));
  });
  return { ops, created, consumed };
}
