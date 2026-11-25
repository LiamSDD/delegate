export type CodeTokenKind =
  "comment" | "string" | "number" | "keyword" | "property" | "variable" | "punctuation";

export interface CodeToken {
  kind: CodeTokenKind | null;
  text: string;
}

export type CodeLanguage = "bash" | "json" | "config" | "sql" | "script" | "yaml";

interface Rule {
  kind: CodeTokenKind | null;
  pattern: RegExp;
}

const LANGUAGE_ALIASES: Readonly<Record<string, CodeLanguage>> = {
  bash: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  json: "json",
  jsonc: "json",
  json5: "json",
  toml: "config",
  ini: "config",
  env: "config",
  dotenv: "config",
  sql: "sql",
  ts: "script",
  tsx: "script",
  typescript: "script",
  js: "script",
  jsx: "script",
  javascript: "script",
  mjs: "script",
  yaml: "yaml",
  yml: "yaml",
};

export function codeLanguage(lang: string | undefined): CodeLanguage | null {
  const name = (lang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return LANGUAGE_ALIASES[name] ?? null;
}

function rule(kind: CodeTokenKind | null, source: string, flags = ""): Rule {
  return { kind, pattern: new RegExp(source, `y${flags}`) };
}

const DOUBLE_QUOTED = String.raw`"(?:\\[\s\S]|[^"\\\n])*"`;
const SINGLE_QUOTED = String.raw`'(?:\\[\s\S]|[^'\\\n])*'`;
const NUMBER = String.raw`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b`;
const HASH_COMMENT = String.raw`(?<=^|\s)#[^\n]*`;
const WORD = String.raw`[A-Za-z_$][\w$]*`;

const SQL_KEYWORDS =
  "ADD ALL ALTER AND AS BEGIN BY CHECK COMMIT CREATE DEFAULT DEFINER DELETE DROP ENABLE END EXISTS FOR FORCE FROM FUNCTION GRANT GROUP IF IN INDEX INHERIT INSERT INTO IS JOIN KEY LEFT LEVEL LIMIT LOCAL LOGIN NOINHERIT NOT NULL ON OR ORDER OWNER PASSWORD POLICY PRIMARY REFERENCES RESET RETURNS REVOKE ROLE ROW SCHEMA SECURITY SELECT SET TABLE TO TRIGGER UPDATE USING VALUES WHERE WITH";

const SCRIPT_KEYWORDS =
  "as async await break case catch class const continue default delete do else export extends finally for from function if implements import in instanceof interface let new of return satisfies static switch throw try type typeof var void while yield";

function words(list: string): string {
  return list.split(" ").join("|");
}

const RULES: Readonly<Record<CodeLanguage, readonly Rule[]>> = {
  bash: [
    rule("comment", HASH_COMMENT, "m"),
    rule("string", DOUBLE_QUOTED),
    rule("string", String.raw`'[^'\n]*'`),
    rule("variable", String.raw`\$\{[^}\n]*\}|\$[A-Za-z_][A-Za-z0-9_]*`),
    rule("variable", String.raw`(?<=^|\s)[A-Z_][A-Z0-9_]*(?==)`, "m"),
    rule(
      "keyword",
      String.raw`(?<=^[ \t]*|[;&|][ \t]*)(?:cd|do|done|elif|else|export|fi|for|if|sudo|then|while)(?=\s|$)`,
      "m",
    ),
    rule(null, String.raw`[\w./:@%+~-]+`),
  ],
  json: [
    rule("property", `${DOUBLE_QUOTED}(?=\\s*:)`),
    rule("string", DOUBLE_QUOTED),
    rule("keyword", String.raw`\b(?:true|false|null)\b`),
    rule("number", NUMBER),
    rule("punctuation", String.raw`[{}\[\],:]`),
  ],
  config: [
    rule("comment", HASH_COMMENT, "m"),
    rule("keyword", String.raw`^[ \t]*\[\[?[^\]\n]*\]\]?`, "m"),
    rule("property", String.raw`^[ \t]*[A-Za-z0-9_.-]+(?=[ \t]*=)`, "m"),
    rule("string", DOUBLE_QUOTED),
    rule("string", SINGLE_QUOTED),
    rule("keyword", String.raw`\b(?:true|false)\b`),
    rule("number", `(?<==[ \\t]*)${NUMBER}(?=[ \\t]*(?:#[^\\n]*)?$)`, "m"),
    rule(null, String.raw`[\w./:@%+~-]+`),
  ],
  sql: [
    rule("comment", String.raw`--[^\n]*|/\*[\s\S]*?\*/`),
    rule("string", String.raw`'(?:''|[^'])*'`),
    rule("keyword", `\\b(?:${words(SQL_KEYWORDS)})\\b`, "i"),
    rule("number", NUMBER),
    rule(null, WORD),
  ],
  script: [
    rule("comment", String.raw`//[^\n]*|/\*[\s\S]*?\*/`),
    rule("string", DOUBLE_QUOTED),
    rule("string", SINGLE_QUOTED),
    rule("string", String.raw`\`(?:\\[\s\S]|[^\`\\])*\``),
    rule("keyword", `\\b(?:${words(SCRIPT_KEYWORDS)})\\b`),
    rule("number", String.raw`\b(?:true|false|null|undefined)\b`),
    rule("number", NUMBER),
    rule(null, WORD),
  ],
  yaml: [
    rule("comment", HASH_COMMENT, "m"),
    rule("property", String.raw`^[ \t]*(?:-[ \t]+)?[A-Za-z0-9_.-]+(?=[ \t]*:(?:\s|$))`, "m"),
    rule("string", DOUBLE_QUOTED),
    rule("string", SINGLE_QUOTED),
    rule("keyword", String.raw`\b(?:true|false|null)\b`),
    rule("number", `(?<=:[ \\t]*)${NUMBER}(?=[ \\t]*(?:#[^\\n]*)?$)`, "m"),
    rule(null, String.raw`[\w./@%+~-]+`),
  ],
};

export function highlight(code: string, lang: string | undefined): CodeToken[] {
  const language = codeLanguage(lang);
  if (language === null) return code === "" ? [] : [{ kind: null, text: code }];
  const rules = RULES[language];
  const tokens: CodeToken[] = [];
  let plain = "";
  let index = 0;
  const push = (kind: CodeTokenKind | null, text: string) => {
    if (kind === null) {
      plain += text;
      return;
    }
    if (plain !== "") tokens.push({ kind: null, text: plain });
    plain = "";
    tokens.push({ kind, text });
  };
  while (index < code.length) {
    let consumed = 0;
    for (const candidate of rules) {
      candidate.pattern.lastIndex = index;
      const match = candidate.pattern.exec(code);
      if (match === null || match[0] === "") continue;
      push(candidate.kind, match[0]);
      consumed = match[0].length;
      break;
    }
    if (consumed === 0) {
      plain += code.charAt(index);
      consumed = 1;
    }
    index += consumed;
  }
  if (plain !== "") tokens.push({ kind: null, text: plain });
  return tokens;
}
