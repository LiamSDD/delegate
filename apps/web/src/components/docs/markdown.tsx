import { ArrowUpRight } from "lucide-react";
import type { Token, Tokens } from "marked";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";

import { isLiveDirective, type LiveDirective } from "@/lib/docs/directives";
import { repoBlobUrl, resolveLink } from "@/lib/docs/links";
import {
  asMarkedToken,
  decodeEntities,
  directiveName,
  inlineText,
  isHtmlComment,
  isLineBreakTag,
  type ParsedMarkdown,
} from "@/lib/docs/markdown";
import type { DocsRegistry } from "@/lib/docs/registry";
import { cn } from "@/lib/utils";

import { CodeBlock } from "./code-block";
import { HEADING_SCROLL_MARGIN, INLINE_CODE_CLASS, LINK_CLASS } from "./styles";

const HEADING_CLASSES: Readonly<Record<number, string>> = {
  1: "mt-12 border-t border-border pt-8 font-serif text-xl tracking-display",
  2: "mt-12 border-t border-border pt-8 font-serif text-xl tracking-display",
  3: "mt-9 text-md font-semibold",
  4: "mt-7 text-base font-semibold",
  5: "mt-6 text-sm font-semibold",
  6: "mt-6 font-mono text-2xs tracking-label text-text-muted uppercase",
};

const ALIGN_CLASSES = { left: "text-left", center: "text-center", right: "text-right" } as const;

interface RenderContext {
  source: string;
  registry: DocsRegistry;
  headingIds: ReadonlyMap<Token, string>;
  directives: Partial<Record<LiveDirective, ReactNode>>;
  plain: boolean;
  section: { id: string | null; text: string | null };
}

const ADR_MENTION = /\bADR (\d{4})\b/g;

function withAdrLinks(text: string, context: RenderContext): ReactNode {
  if (context.plain) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(ADR_MENTION)) {
    const target = context.registry.adrByNumber(match[1] ?? "");
    if (target === undefined || target.source === context.source) continue;
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    parts.push(
      <Link key={match.index} href={target.route} className={LINK_CLASS} title={target.label}>
        {match[0]}
      </Link>,
    );
    cursor = match.index + match[0].length;
  }
  if (parts.length === 0) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function isPageLink(href: string): boolean {
  const pathname = href.split(/[?#]/)[0] ?? "";
  return !pathname.startsWith("/api/") && !/\.[a-z0-9]+$/i.test(pathname);
}

function ExternalMark({ repo }: { repo: boolean }) {
  return (
    <>
      <ArrowUpRight
        className="ml-0.5 inline size-3 align-baseline"
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <span className="sr-only">{repo ? " (opens on GitHub)" : " (opens in a new tab)"}</span>
    </>
  );
}

function renderLink(
  href: string,
  title: string | null | undefined,
  children: ReactNode,
  context: RenderContext,
): ReactNode {
  const resolved = resolveLink(href, context.source, context.registry);
  const hint = title === null || title === undefined || title === "" ? undefined : title;
  switch (resolved.kind) {
    case "invalid":
      return children;
    case "anchor":
      return (
        <a href={resolved.href} title={hint} className={LINK_CLASS}>
          {children}
        </a>
      );
    case "doc":
      return (
        <Link href={resolved.href} title={hint} className={LINK_CLASS}>
          {children}
        </Link>
      );
    case "site":
      return isPageLink(resolved.href) ? (
        <Link href={resolved.href} title={hint} className={LINK_CLASS}>
          {children}
        </Link>
      ) : (
        <a href={resolved.href} title={hint} className={LINK_CLASS}>
          {children}
        </a>
      );
    case "repo":
    case "external":
      return (
        <a
          href={resolved.href}
          title={hint}
          target="_blank"
          rel="noreferrer"
          className={LINK_CLASS}
        >
          {children}
          <ExternalMark repo={resolved.kind === "repo"} />
        </a>
      );
  }
}

function breakable(text: string): ReactNode {
  const parts = text.split(/(?<=[/])(?=[^/])/);
  if (parts.length === 1) return text;
  return parts.map((part, index) => (
    <Fragment key={index}>
      {index === 0 ? null : <wbr />}
      {part}
    </Fragment>
  ));
}

function renderCodeSpan(text: string, context: RenderContext): ReactNode {
  const code = <code className={INLINE_CODE_CLASS}>{breakable(text)}</code>;
  if (context.plain) return code;
  const target = context.registry.bySource(text);
  if (target === undefined || target.source === context.source) return code;
  return (
    <Link href={target.route} title={target.label} className="rounded-xs hover:text-accent">
      <code
        className={cn(
          INLINE_CODE_CLASS,
          "underline decoration-border-strong underline-offset-[3px]",
        )}
      >
        {breakable(text)}
      </code>
    </Link>
  );
}

function renderInline(tokens: readonly Token[], context: RenderContext): ReactNode[] {
  return tokens.map((token, index) => {
    const known = asMarkedToken(token);
    if (known === null) return <Fragment key={index}>{token.raw}</Fragment>;
    switch (known.type) {
      case "text":
        return (
          <Fragment key={index}>
            {known.tokens === undefined
              ? withAdrLinks(decodeEntities(known.text), context)
              : renderInline(known.tokens, context)}
          </Fragment>
        );
      case "escape":
        return <Fragment key={index}>{known.text}</Fragment>;
      case "strong":
        return (
          <strong key={index} className="font-semibold text-text">
            {renderInline(known.tokens, context)}
          </strong>
        );
      case "em":
        return <em key={index}>{renderInline(known.tokens, context)}</em>;
      case "del":
        return (
          <del key={index} className="text-text-muted">
            {renderInline(known.tokens, context)}
          </del>
        );
      case "codespan":
        return <Fragment key={index}>{renderCodeSpan(known.text, context)}</Fragment>;
      case "br":
        return <br key={index} />;
      case "link":
        return (
          <Fragment key={index}>
            {context.plain
              ? renderInline(known.tokens, context)
              : renderLink(
                  known.href,
                  known.title,
                  renderInline(known.tokens, { ...context, plain: true }),
                  context,
                )}
          </Fragment>
        );
      case "image":
        return (
          <Fragment key={index}>
            {context.plain
              ? known.text
              : renderLink(known.href, known.title, `${known.text} (image)`, context)}
          </Fragment>
        );
      case "html":
        if (isLineBreakTag(known.text)) return <br key={index} />;
        if (isHtmlComment(known.text)) return null;
        return <Fragment key={index}>{known.text}</Fragment>;
      default:
        return <Fragment key={index}>{known.raw}</Fragment>;
    }
  });
}

function renderHeading(token: Tokens.Heading, context: RenderContext): ReactNode {
  const id = context.headingIds.get(token);
  const depth = Math.min(Math.max(token.depth, 2), 6);
  const Tag = `h${depth}` as "h2" | "h3" | "h4" | "h5" | "h6";
  const text = inlineText(token.tokens).replace(/\s+/g, " ").trim();
  const children = renderInline(token.tokens, { ...context, plain: true });
  if (id === undefined)
    return <Tag className={cn("text-text", HEADING_CLASSES[token.depth])}>{children}</Tag>;
  context.section.id = id;
  context.section.text = text;
  return (
    <Tag
      id={id}
      className={cn("group text-text", HEADING_SCROLL_MARGIN, HEADING_CLASSES[token.depth])}
    >
      {children}
      <a
        href={`#${encodeURIComponent(id)}`}
        aria-label={`Link to the section: ${text}`}
        className="ml-2 rounded-xs font-sans text-base font-normal text-text-subtle opacity-0 transition-opacity group-hover:opacity-100 hover:text-accent focus-visible:opacity-100"
      >
        #
      </a>
    </Tag>
  );
}

function renderTable(token: Tokens.Table, context: RenderContext): ReactNode {
  return (
    <div
      role="region"
      aria-label={context.section.text === null ? "Table" : `Table: ${context.section.text}`}
      tabIndex={0}
      className="mt-5 overflow-x-auto rounded-lg border border-border bg-surface"
    >
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {token.header.map((cell, index) => (
              <th
                key={index}
                scope="col"
                className={cn(
                  "border-b border-border bg-surface-2 px-3.5 py-2 align-bottom font-medium whitespace-nowrap text-text",
                  ALIGN_CLASSES[cell.align ?? "left"],
                )}
              >
                {renderInline(cell.tokens, context)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {token.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-border last:border-b-0">
              {row.map((cell, index) => (
                <td
                  key={index}
                  className={cn(
                    "min-w-32 px-3.5 py-2.5 align-top text-text",
                    ALIGN_CLASSES[cell.align ?? "left"],
                  )}
                >
                  {renderInline(cell.tokens, context)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderListItem(item: Tokens.ListItem, context: RenderContext, key: number): ReactNode {
  const body = item.tokens.filter((token) => token.type !== "checkbox");
  const content = renderBlocks(body, context, true);
  if (!item.task)
    return (
      <li key={key} className="pl-1">
        {content}
      </li>
    );
  return (
    <li key={key} className="-ml-5 flex list-none items-start gap-2.5">
      <input
        type="checkbox"
        checked={item.checked === true}
        disabled
        readOnly
        aria-label={item.checked === true ? "Done" : "Not done"}
        className="mt-1.5 size-3.5 shrink-0 accent-[var(--accent)]"
      />
      <div className="min-w-0 flex-1">{content}</div>
    </li>
  );
}

function isInvisible(token: Token): boolean {
  const known = asMarkedToken(token);
  return known?.type === "html" && isHtmlComment(known.text);
}

function renderBlock(token: Token, context: RenderContext, nested: boolean): ReactNode {
  const known = asMarkedToken(token);
  if (known === null) return <p className="mt-4">{token.raw}</p>;
  switch (known.type) {
    case "space":
    case "def":
      return null;
    case "heading":
      return renderHeading(known, context);
    case "paragraph": {
      const visible = known.tokens.some((child) => !isInvisible(child));
      return visible ? (
        <p className={nested ? "mt-2 first:mt-0" : "mt-4"}>{renderInline(known.tokens, context)}</p>
      ) : null;
    }
    case "text":
      return known.tokens === undefined
        ? withAdrLinks(decodeEntities(known.text), context)
        : renderInline(known.tokens, context);
    case "code": {
      const mermaid = (known.lang ?? "").trim().toLowerCase() === "mermaid";
      return (
        <CodeBlock
          code={known.text}
          lang={known.lang}
          renderedUrl={
            mermaid
              ? `${repoBlobUrl(context.source)}${
                  context.section.id === null ? "" : `#${encodeURIComponent(context.section.id)}`
                }`
              : undefined
          }
        />
      );
    }
    case "blockquote":
      return (
        <blockquote className="mt-5 border-l-2 border-border-strong pl-4 text-text-muted [&>*:first-child]:mt-0">
          {renderBlocks(known.tokens, context, false)}
        </blockquote>
      );
    case "list": {
      const className = cn(
        "flex flex-col gap-1.5 pl-5 marker:text-text-subtle",
        nested ? "mt-1.5" : "mt-4",
        known.ordered ? "list-decimal" : "list-disc",
      );
      const items = known.items.map((item, index) => renderListItem(item, context, index));
      return known.ordered ? (
        <ol
          start={known.start === "" || known.start === 1 ? undefined : known.start}
          className={className}
        >
          {items}
        </ol>
      ) : (
        <ul className={className}>{items}</ul>
      );
    }
    case "table":
      return renderTable(known, context);
    case "hr":
      return <hr className="mt-10 border-border" />;
    case "html": {
      const directive = directiveName(known.text);
      if (directive !== null)
        return isLiveDirective(directive) ? (context.directives[directive] ?? null) : null;
      if (isHtmlComment(known.text)) return null;
      return <CodeBlock code={known.text.replace(/\n+$/, "")} lang="html" />;
    }
    default:
      return <p className="mt-4">{renderInline([known], context)}</p>;
  }
}

function renderBlocks(
  tokens: readonly Token[],
  context: RenderContext,
  nested: boolean,
): ReactNode[] {
  return tokens.map((token, index) => (
    <Fragment key={index}>{renderBlock(token, context, nested)}</Fragment>
  ));
}

export function Markdown({
  markdown,
  source,
  registry,
  directives = {},
}: {
  markdown: ParsedMarkdown;
  source: string;
  registry: DocsRegistry;
  directives?: Partial<Record<LiveDirective, ReactNode>>;
}) {
  const context: RenderContext = {
    source,
    registry,
    headingIds: markdown.headingIds,
    directives,
    plain: false,
    section: { id: null, text: null },
  };
  return (
    <div className="text-base text-text [&>*:first-child]:mt-0 [&>*:first-child]:border-t-0 [&>*:first-child]:pt-0">
      {renderBlocks(markdown.tokens, context, false)}
    </div>
  );
}
