import { readFileSync } from "node:fs";

export const FIXTURE_ORIGIN = "https://www.acme.example";

function fixture(name: string): string {
  return readFileSync(new URL(`../tools/fixtures/${name}`, import.meta.url), "utf8");
}

function html(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function xml(body: string): Response {
  return new Response(body, { headers: { "content-type": "application/xml" } });
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main>${body}</main></body></html>`;
}

const HOME = `<!doctype html><html lang="en"><head>
<title>Acme Robotics | Warehouse picking robots</title>
<meta name="description" content="Acme Robotics builds autonomous picking robots for mid-size warehouses.">
<meta property="og:site_name" content="Acme Robotics">
<link rel="alternate" type="application/rss+xml" href="/blog/feed.xml">
</head><body>
<nav><a href="/about">About</a> <a href="/pricing">Pricing</a> <a href="/customers">Customers</a> <a href="/careers">Careers</a> <a href="https://github.com/acme-robotics">GitHub</a></nav>
<main><h1>Robots that pick and pack</h1>
<p>Acme Robotics builds autonomous picking robots for mid-size warehouses and 3PL providers.</p>
<p>Our fleet software runs on Kubernetes and integrates with SAP and Manhattan WMS.</p></main>
</body></html>`;

export const FIXTURE_PAGES: Record<string, () => Response> = {
  [`${FIXTURE_ORIGIN}/robots.txt`]: () =>
    new Response(`User-agent: *\nDisallow: /admin\nSitemap: ${FIXTURE_ORIGIN}/sitemap.xml\n`, {
      headers: { "content-type": "text/plain" },
    }),
  [`${FIXTURE_ORIGIN}/sitemap.xml`]: () =>
    xml(`<urlset>
      ${[
        "/",
        "/about",
        "/pricing",
        "/customers",
        "/careers",
        "/admin/secret",
        "/de/about",
        "/assets/logo.png",
        "/vs/robocorp",
      ]
        .map((path) => `<url><loc>${FIXTURE_ORIGIN}${path}</loc></url>`)
        .join("")}
    </urlset>`),
  [`${FIXTURE_ORIGIN}/`]: () => html(HOME),
  [`${FIXTURE_ORIGIN}/about`]: () => html(fixture("hidden-injection.html")),
  [`${FIXTURE_ORIGIN}/pricing`]: () =>
    html(
      page(
        "Pricing",
        "<h1>Pricing</h1><p>Robots are leased from 1,900 EUR per robot per month.</p>",
      ),
    ),
  [`${FIXTURE_ORIGIN}/customers`]: () =>
    html(
      page(
        "Customers",
        "<h1>Customers</h1><p>Northwind Logistics cut picking time by 40 percent with Acme.</p>",
      ),
    ),
  [`${FIXTURE_ORIGIN}/careers`]: () =>
    html(
      page(
        "Careers",
        "<h1>Careers</h1><p>We are hiring robotics engineers in Berlin and Austin.</p>",
      ),
    ),
  [`${FIXTURE_ORIGIN}/vs/robocorp`]: () =>
    html(
      page(
        "Acme vs RoboCorp",
        "<h1>Acme vs RoboCorp</h1><p>Unlike RoboCorp, Acme robots need no fixed rails.</p>",
      ),
    ),
  [`${FIXTURE_ORIGIN}/blog/feed.xml`]: () =>
    xml(`<rss><channel><item><title>Acme raises Series B</title><link>${FIXTURE_ORIGIN}/blog/series-b</link>
      <pubDate>Tue, 03 Nov 2026 09:00:00 GMT</pubDate><description>Acme raised 30 million EUR to expand to the US.</description></item></channel></rss>`),
};

const WIKIDATA_ENTITY = {
  entities: {
    Q1: {
      id: "Q1",
      labels: { en: { value: "Acme Robotics" } },
      descriptions: { en: { value: "German warehouse robotics company" } },
      sitelinks: { enwiki: { title: "Acme Robotics" } },
      claims: {
        P856: [{ mainsnak: { datavalue: { value: "https://www.acme.example" } } }],
        P571: [{ mainsnak: { datavalue: { value: { time: "+2019-03-01T00:00:00Z" } } } }],
        P452: [{ mainsnak: { datavalue: { value: { id: "Q10" } } } }],
        P159: [{ mainsnak: { datavalue: { value: { id: "Q11" } } } }],
      },
    },
    Q2: {
      id: "Q2",
      labels: { en: { value: "Acme Corporation" } },
      claims: { P856: [{ mainsnak: { datavalue: { value: "https://acme-corp.example" } } }] },
    },
  },
};

export function fixtureApi(url: URL): Response | undefined {
  if (url.hostname === "www.wikidata.org" && url.pathname === "/w/api.php") {
    const action = url.searchParams.get("action");
    if (action === "wbsearchentities") return json({ search: [{ id: "Q2" }, { id: "Q1" }] });
    if (action === "wbgetentities" && url.searchParams.get("props") === "labels") {
      return json({
        entities: {
          Q10: { labels: { en: { value: "robotics" } } },
          Q11: { labels: { en: { value: "Berlin" } } },
        },
      });
    }
    if (action === "wbgetentities") return json(WIKIDATA_ENTITY);
  }
  if (url.href === "https://en.wikipedia.org/api/rest_v1/page/summary/Acme_Robotics") {
    return json({
      title: "Acme Robotics",
      extract:
        "Acme Robotics is a German company that makes autonomous mobile picking robots. It competes with RoboCorp.",
      content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Acme_Robotics" } },
    });
  }
  if (url.href === "https://api.github.com/orgs/acme-robotics") {
    return json({
      login: "acme-robotics",
      name: "Acme Robotics",
      blog: "https://www.acme.example",
      description: "Open-source tools from Acme Robotics",
      public_repos: 3,
      html_url: "https://github.com/acme-robotics",
    });
  }
  if (url.pathname === "/orgs/acme-robotics/repos" && url.hostname === "api.github.com") {
    return json([
      {
        name: "fleet-sim",
        description: "Fleet simulator",
        language: "Rust",
        stargazers_count: 120,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme-robotics/fleet-sim",
      },
      {
        name: "pick-planner",
        description: "Grasp planning",
        language: "Python",
        stargazers_count: 80,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme-robotics/pick-planner",
      },
      {
        name: "ros2",
        description: null,
        language: "C++",
        stargazers_count: 5,
        fork: true,
        archived: false,
        html_url: "https://github.com/acme-robotics/ros2",
      },
    ]);
  }
  return undefined;
}

export interface FixtureFetch {
  fetchImpl: typeof fetch;
  requested: string[];
}

export function fixtureFetch(
  extra?: (url: URL, init: RequestInit | undefined) => Response | undefined,
): FixtureFetch {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requested.push(url.href);
    const response =
      extra?.(url, init) ??
      FIXTURE_PAGES[url.href]?.() ??
      fixtureApi(url) ??
      new Response("not found", { status: 404 });
    return Promise.resolve(response);
  };
  return { fetchImpl, requested };
}

export const fixtureDns = (host: string): Promise<string[]> =>
  Promise.resolve(host.endsWith("169.254.169.254") ? ["169.254.169.254"] : ["93.184.216.34"]);
