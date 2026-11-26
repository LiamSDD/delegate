import { buildOpenApiDocument } from "@delegate/sdk/contract";
import Link from "next/link";
import type { ReactNode } from "react";

import { parseMarkdown } from "@/lib/docs/markdown";
import {
  type ApiContent,
  type ApiOperation,
  type ApiProperty,
  type ApiReferenceModel,
  OPENAPI_PATH,
  parseOpenApi,
  schemaId,
} from "@/lib/docs/openapi";
import type { DocsRegistry } from "@/lib/docs/registry";
import { cn } from "@/lib/utils";

import { Markdown } from "./markdown";
import { HEADING_SCROLL_MARGIN, LINK_CLASS } from "./styles";

export type ApiReferenceState =
  { status: "unavailable"; detail: string } | { status: "ready"; model: ApiReferenceModel };

export function apiReferenceState(document: unknown): ApiReferenceState {
  const model = parseOpenApi(document);
  return model === null
    ? {
        status: "unavailable",
        detail: `The document served at ${OPENAPI_PATH} is not an OpenAPI 3 document.`,
      }
    : { status: "ready", model };
}

interface ProseContext {
  registry: DocsRegistry;
  source: string;
}

function Prose({
  text,
  context,
  inline = false,
  className,
}: {
  text: string;
  context: ProseContext;
  inline?: boolean;
  className?: string;
}) {
  return (
    <Markdown
      markdown={parseMarkdown(text)}
      source={context.source}
      registry={context.registry}
      inline={inline}
      className={className}
    />
  );
}

const METHOD_TONES: Readonly<Record<string, string>> = {
  GET: "bg-accent-soft text-accent",
  POST: "bg-success-soft text-success",
  PUT: "bg-warning-soft text-warning",
  PATCH: "bg-warning-soft text-warning",
  DELETE: "bg-danger-soft text-danger",
};

function TypeLabel({ type, known }: { type: string; known: ReadonlySet<string> }) {
  const parts = type.split(/([A-Za-z_][\w.-]*)/);
  return (
    <code className="font-mono text-xs text-text [overflow-wrap:anywhere]">
      {parts.map((part, index) =>
        known.has(part) ? (
          <a key={index} href={`#${schemaId(part)}`} className={LINK_CLASS}>
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </code>
  );
}

function PropertyTable({
  caption,
  rows,
  known,
  prose,
}: {
  caption: string;
  rows: readonly (ApiProperty & { in?: string })[];
  known: ReadonlySet<string>;
  prose: ProseContext;
}) {
  const located = rows.some((row) => row.in !== undefined);
  return (
    <div
      role="region"
      aria-label={caption}
      tabIndex={0}
      className="overflow-x-auto rounded-lg border border-border bg-surface"
    >
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {["Name", ...(located ? ["In"] : []), "Type", "Description"].map((heading) => (
              <th
                key={heading}
                scope="col"
                className="border-b border-border bg-surface-2 px-3.5 py-2 text-left font-medium whitespace-nowrap text-text"
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.in ?? ""}:${row.name}`}
              className="border-b border-border last:border-b-0"
            >
              <td className="px-3.5 py-2 align-top whitespace-nowrap">
                <code className="font-mono text-xs text-text">{row.name}</code>
                {row.required ? (
                  <span className="ml-2 font-mono text-2xs text-warning">required</span>
                ) : null}
              </td>
              {located ? (
                <td className="px-3.5 py-2 align-top font-mono text-xs text-text-muted">
                  {row.in}
                </td>
              ) : null}
              <td className="px-3.5 py-2 align-top">
                <TypeLabel type={row.type} known={known} />
              </td>
              <td className="min-w-40 px-3.5 py-2 align-top text-text-muted">
                {row.description === null ? null : (
                  <Prose text={row.description} context={prose} inline className="text-sm" />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Contents({
  label,
  contents,
  known,
  prose,
}: {
  label: string;
  contents: readonly ApiContent[];
  known: ReadonlySet<string>;
  prose: ProseContext;
}) {
  return (
    <>
      {contents.map((content) => (
        <div key={content.mediaType} className="flex flex-col gap-2">
          <p className="text-sm text-text-muted">
            <span className="font-mono text-xs">{content.mediaType}</span>
            {content.schema === null ? null : (
              <>
                {" · "}
                <TypeLabel type={content.schema.type} known={known} />
              </>
            )}
          </p>
          {content.schema === null || content.schema.properties.length === 0 ? null : (
            <PropertyTable
              caption={`${label}, ${content.mediaType}`}
              rows={content.schema.properties}
              known={known}
              prose={prose}
            />
          )}
        </div>
      ))}
    </>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <h5 className="font-mono text-2xs tracking-label text-text-subtle uppercase">{children}</h5>
  );
}

function Operation({
  operation,
  known,
  prose,
}: {
  operation: ApiOperation;
  known: ReadonlySet<string>;
  prose: ProseContext;
}) {
  return (
    <article
      id={operation.id}
      aria-label={`${operation.method} ${operation.path}`}
      className={cn("flex flex-col gap-4 border-t border-border pt-6", HEADING_SCROLL_MARGIN)}
    >
      <h4 className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className={cn(
            "rounded-sm px-1.5 py-0.5 font-mono text-2xs font-medium",
            METHOD_TONES[operation.method] ?? "bg-surface-2 text-text-muted",
          )}
        >
          {operation.method}
        </span>
        <code className="font-mono text-sm text-text [overflow-wrap:anywhere]">
          {operation.path}
        </code>
        {operation.deprecated ? (
          <span className="font-mono text-2xs text-warning">deprecated</span>
        ) : null}
      </h4>
      {operation.summary === null ? null : (
        <p className="text-base font-medium text-text">{operation.summary}</p>
      )}
      {operation.description === null ? null : (
        <Prose text={operation.description} context={prose} className="text-sm text-text-muted" />
      )}
      {operation.security === null ? null : (
        <p className="text-sm text-text-muted">
          {operation.security.length === 0 ? (
            "No authentication."
          ) : (
            <>
              Authentication:{" "}
              <span className="font-mono text-xs">{operation.security.join(", ")}</span>
            </>
          )}
        </p>
      )}
      {operation.parameters.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <Label>Parameters</Label>
          <PropertyTable
            caption={`Parameters of ${operation.method} ${operation.path}`}
            rows={operation.parameters}
            known={known}
            prose={prose}
          />
        </div>
      )}
      {operation.requestBody === null ? null : (
        <div className="flex flex-col gap-2">
          <Label>Request body{operation.requestBody.required ? " (required)" : ""}</Label>
          {operation.requestBody.description === null ? null : (
            <Prose
              text={operation.requestBody.description}
              context={prose}
              className="text-sm text-text-muted"
            />
          )}
          <Contents
            label={`Request body of ${operation.method} ${operation.path}`}
            contents={operation.requestBody.contents}
            known={known}
            prose={prose}
          />
        </div>
      )}
      {operation.responses.length === 0 ? null : (
        <div className="flex flex-col gap-3">
          <Label>Responses</Label>
          {operation.responses.map((response) => (
            <div key={response.status} className="flex flex-col gap-2">
              <div className="flex items-baseline gap-3 text-sm">
                <span className="shrink-0 font-mono text-xs font-medium text-text">
                  {response.status}
                </span>
                {response.description === null ? null : (
                  <Prose
                    text={response.description}
                    context={prose}
                    className="min-w-0 flex-1 text-sm text-text-muted [&>p]:mt-1"
                  />
                )}
              </div>
              <Contents
                label={`Response ${response.status} of ${operation.method} ${operation.path}`}
                contents={response.contents}
                known={known}
                prose={prose}
              />
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

export function ApiReferenceView({
  state,
  registry,
  source,
}: {
  state: ApiReferenceState;
  registry: DocsRegistry;
  source: string;
}) {
  if (state.status === "unavailable")
    return (
      <div
        role="note"
        className="mt-5 flex flex-col gap-2 rounded-lg border border-border bg-surface px-4 py-3.5 text-sm"
      >
        <p className="font-medium text-text">
          The REST reference is not available on this deployment.
        </p>
        <p className="text-text-muted">
          {state.detail} This page renders that document and nothing else, so there is no reference
          to show. The web app and the MCP endpoint do not depend on it:{" "}
          <Link href="/docs/guides/mcp-clients" className={LINK_CLASS}>
            connect an MCP client
          </Link>{" "}
          to start and read runs from your own tools.
        </p>
      </div>
    );

  const { model } = state;
  const known = new Set(model.schemas.map((schema) => schema.name));
  const prose: ProseContext = { registry, source };
  return (
    <div className="mt-6 flex flex-col gap-10">
      <header className="flex flex-col gap-3">
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-md font-semibold text-text">{model.title}</span>
          <span className="font-mono text-xs text-text-muted">
            version {model.version} · OpenAPI {model.specVersion}
          </span>
        </p>
        {model.description === null ? null : (
          <Prose text={model.description} context={prose} className="text-sm text-text-muted" />
        )}
        {model.servers.length === 0 ? null : (
          <p className="text-sm text-text-muted">
            Base URL:{" "}
            {model.servers.map((server, index) => (
              <span key={server.url}>
                {index === 0 ? "" : ", "}
                <code className="font-mono text-xs text-text">{server.url}</code>
                {server.description === null ? "" : ` (${server.description})`}
              </span>
            ))}
          </p>
        )}
        {model.security.length === 0 ? null : (
          <ul className="flex flex-col gap-1 text-sm text-text-muted">
            {model.security.map((scheme) => (
              <li key={scheme.name}>
                <span className="font-mono text-xs text-text">{scheme.name}</span>
                {" · "}
                <span className="font-mono text-xs">{scheme.summary}</span>
                {scheme.description === null ? null : (
                  <>
                    {" · "}
                    <Prose text={scheme.description} context={prose} inline />
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </header>
      {model.groups.map((group) => (
        <section key={group.name} aria-label={group.name} className="flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <h3 className="text-md font-semibold text-text">{group.name}</h3>
            {group.description === null ? null : (
              <Prose text={group.description} context={prose} className="text-sm text-text-muted" />
            )}
          </div>
          {group.operations.map((operation) => (
            <Operation key={operation.id} operation={operation} known={known} prose={prose} />
          ))}
        </section>
      ))}
      {model.schemas.length === 0 ? null : (
        <section aria-label="Schemas" className="flex flex-col gap-6">
          <h3 className="text-md font-semibold text-text">Schemas</h3>
          {model.schemas.map((schema) => (
            <div
              key={schema.name}
              id={schema.id}
              className={cn(
                "flex flex-col gap-2 border-t border-border pt-5",
                HEADING_SCROLL_MARGIN,
              )}
            >
              <h4 className="flex flex-wrap items-baseline gap-x-3">
                <code className="font-mono text-sm text-text">{schema.name}</code>
                <span className="font-mono text-2xs text-text-subtle">{schema.view.type}</span>
              </h4>
              {schema.view.description === null ? null : (
                <Prose
                  text={schema.view.description}
                  context={prose}
                  className="text-sm text-text-muted"
                />
              )}
              {schema.view.properties.length === 0 ? null : (
                <PropertyTable
                  caption={`Properties of ${schema.name}`}
                  rows={schema.view.properties}
                  known={known}
                  prose={prose}
                />
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

export function ApiReference({ registry, source }: { registry: DocsRegistry; source: string }) {
  return (
    <ApiReferenceView
      state={apiReferenceState(buildOpenApiDocument())}
      registry={registry}
      source={source}
    />
  );
}
