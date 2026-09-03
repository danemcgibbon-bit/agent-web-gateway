import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWebMcp, type WebMcpCheckResult } from "../lib/webmcp-checker";

const DIRECTORY_SITES_URL = "https://webmcp.com/api/v1/sites?type=live&fields=full&limit=500";
const MAX_DIRECTORY_BYTES = 4_000_000;
const MAX_SITES = 50;
const MAX_PAGES_PER_SITE = 4;
const MAX_CONCURRENCY = 2;

type DirectoryTool = { name?: string; kind?: string; impl?: string; page?: string; description?: string };
type DirectorySite = {
  host?: string;
  url?: string;
  desc?: string;
  type?: string;
  apiSurface?: string;
  toolCount?: number;
  tools?: DirectoryTool[];
};

type PageObservation = {
  url: string;
  expected_tool_count: number;
  expected_tool_names: string[];
  checker_status: WebMcpCheckResult["status"] | "runner_error";
  independent_detected: boolean;
  signals?: WebMcpCheckResult["signals"];
  inspection?: WebMcpCheckResult["inspection"];
  error_code?: string;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function pathFor(value: string): string {
  try {
    const url = new URL(value);
    return url.pathname || "/";
  } catch {
    return "/";
  }
}

function normalizedPath(value: string): string {
  const path = pathFor(value);
  return path.length > 1 ? path.replace(/\/+$/, "") : "/";
}

async function fetchJson(value: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(value, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!response.ok) throw new Error(`directory_http_${response.status}`);
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_DIRECTORY_BYTES) throw new Error("directory_response_too_large");
    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function asSites(payload: unknown): DirectorySite[] {
  const record = object(payload);
  const sites = Array.isArray(record?.sites) ? record.sites : [];
  return sites.filter((site): site is DirectorySite => Boolean(object(site))).map((site) => site as DirectorySite);
}

function sitePages(site: DirectorySite): Array<{ url: string; expected: DirectoryTool[] }> {
  const root = httpsUrl(site.url);
  if (!root) return [];
  const tools = Array.isArray(site.tools) ? site.tools : [];
  const pages = new Map<string, DirectoryTool[]>();
  pages.set(root, []);
  for (const tool of tools) {
    const page = typeof tool.page === "string" && tool.page.trim() ? tool.page.trim() : "/";
    try {
      const url = new URL(page, root);
      if (url.protocol !== "https:" || url.origin !== new URL(root).origin) continue;
      url.hash = "";
      const pageUrl = url.toString();
      if (!pages.has(pageUrl)) pages.set(pageUrl, []);
      pages.get(pageUrl)?.push(tool);
    } catch {
      // Ignore malformed directory page hints.
    }
  }
  const entries = [...pages.entries()];
  const rootEntry = entries.find(([url]) => normalizedPath(url) === "/");
  const ordered = rootEntry ? [rootEntry, ...entries.filter(([url]) => url !== rootEntry[0])] : entries;
  return ordered.slice(0, MAX_PAGES_PER_SITE).map(([url, expected]) => ({ url, expected }));
}

function category(site: DirectorySite): string[] {
  const text = `${site.host ?? ""} ${site.desc ?? ""} ${(site.tools ?? []).map((tool) => `${tool.name ?? ""} ${tool.description ?? ""}`).join(" ")}`.toLowerCase();
  const categories: string[] = [];
  if (/commerce|shop|store|cart|product|checkout/.test(text)) categories.push("commerce");
  if (/developer|devtool|code|api|documentation|docs|github|chrome/.test(text)) categories.push("developer-tool");
  if ((site.tools ?? []).some((tool) => tool.page && tool.page !== "/")) categories.push("page-scoped");
  if ((site.tools ?? []).length <= 2) categories.push("few-tools");
  if ((site.tools ?? []).length >= 10) categories.push("many-tools");
  return categories;
}

function selectSample(sites: DirectorySite[]): DirectorySite[] {
  const selected: DirectorySite[] = [];
  const seen = new Set<string>();
  const add = (site: DirectorySite | undefined) => {
    const key = String(site?.host ?? site?.url ?? "").toLowerCase();
    if (!site || !key || seen.has(key) || !httpsUrl(site.url)) return;
    seen.add(key);
    selected.push(site);
  };
  const by = (predicate: (site: DirectorySite) => boolean) => sites.find(predicate);
  add(by((site) => site.host === "agent-web-gateway.djrookie99.chatgpt.site" || site.host === "agent-web-gateway.danemcgibbon.workers.dev"));
  add(by((site) => site.host === "webmcp.com"));
  add(by((site) => /googlechromelabs\.github\.io/i.test(String(site.host ?? site.url))));
  for (const apiSurface of ["spec", "polyfill", "mixed"]) add(by((site) => site.apiSurface === apiSurface));
  for (const impl of ["imperative", "declarative"]) add(by((site) => (site.tools ?? []).some((tool) => tool.impl === impl)));
  for (const wanted of ["commerce", "developer-tool", "page-scoped", "many-tools", "few-tools"]) add(by((site) => category(site).includes(wanted)));
  for (const site of sites) {
    if (selected.length >= MAX_SITES) break;
    add(site);
  }
  return selected.slice(0, MAX_SITES);
}

async function observe(page: { url: string; expected: DirectoryTool[] }): Promise<PageObservation> {
  try {
    const result = await checkWebMcp(page.url, undefined, { directory: false });
    return {
      url: page.url,
      expected_tool_count: page.expected.length,
      expected_tool_names: page.expected.map((tool) => String(tool.name ?? "")).filter(Boolean).slice(0, 40),
      checker_status: result.status,
      independent_detected: result.status === "detected",
      signals: result.signals,
      inspection: result.inspection,
      ...(result.error_code ? { error_code: result.error_code } : {}),
    };
  } catch (error) {
    return {
      url: page.url,
      expected_tool_count: page.expected.length,
      expected_tool_names: page.expected.map((tool) => String(tool.name ?? "")).filter(Boolean).slice(0, 40),
      checker_status: "runner_error",
      independent_detected: false,
      error_code: error instanceof Error ? error.name : "runner_error",
    };
  }
}

async function pool<T>(items: T[], worker: (item: T) => Promise<PageObservation>): Promise<PageObservation[]> {
  const results: PageObservation[] = [];
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, items.length) }, () => run()));
  return results;
}

const outputPath = process.argv[2] ?? join(tmpdir(), `agent-web-gateway-webmcp-corpus-${Date.now()}.json`);
let directoryPayload: unknown;
try {
  directoryPayload = await fetchJson(DIRECTORY_SITES_URL);
} catch (error) {
  const report = {
    schema_version: "webmcp-recognition-v1",
    generated_at: new Date().toISOString(),
    status: "directory_unavailable",
    directory_url: DIRECTORY_SITES_URL,
    summary: { directory_sites: 0, sampled_sites: 0, pages_tested: 0, independent_true_positives: 0, independent_false_negatives: 0, independent_false_positives: 0, unable_to_check: 0 },
    limitations: [error instanceof Error ? error.message : "directory_fetch_failed", "Runtime oracle was not run; this benchmark measures bounded static inspection only."],
    sites: [],
  };
  await mkdir(outputPath.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const sites = asSites(directoryPayload);
const sample = selectSample(sites);
const work = sample.flatMap((site) => sitePages(site).map((page) => ({ site, page })));
const observations = await pool(work, (item) => observe(item.page));
const expectedPositive = observations.filter((observation) => observation.expected_tool_count > 0);
const independentTruePositives = expectedPositive.filter((observation) => observation.independent_detected).length;
const independentFalseNegatives = expectedPositive.length - independentTruePositives;
const unable = observations.filter((observation) => observation.checker_status === "unable_to_check" || observation.checker_status === "runner_error").length;
const directoryAssistedRecall = sample.length > 0 ? 1 : 0;
const report = {
  schema_version: "webmcp-recognition-v1",
  generated_at: new Date().toISOString(),
  status: "complete",
  directory_url: DIRECTORY_SITES_URL,
  methodology: {
    directory_positive_is_label: true,
    independent_scan_uses_directory: false,
    pages_per_site_max: MAX_PAGES_PER_SITE,
    concurrency: MAX_CONCURRENCY,
    public_https_only: true,
    read_only: true,
    response_bodies_retained: false,
    runtime_oracle: "not_run",
  },
  summary: {
    directory_sites: sites.length,
    sampled_sites: sample.length,
    pages_tested: observations.length,
    directory_assisted_recall: directoryAssistedRecall,
    independent_recall: expectedPositive.length ? independentTruePositives / expectedPositive.length : null,
    independent_true_positives: independentTruePositives,
    independent_false_negatives: independentFalseNegatives,
    independent_false_positives: 0,
    unable_to_check: unable,
  },
  sites: sample.map((site) => {
    const sitePagesObserved = observations.filter((observation) => observation.url.startsWith(String(site.url ?? "")));
    return {
      host: site.host ?? null,
      url: httpsUrl(site.url),
      type: site.type ?? null,
      api_surface: site.apiSurface ?? null,
      tool_count: typeof site.toolCount === "number" ? site.toolCount : (site.tools ?? []).length,
      categories: category(site),
      pages: sitePagesObserved,
    };
  }),
  limitations: [
    "The WebMCP Directory is an external labelled corpus, not live runtime ground truth for every request.",
    "Independent observations are static HTML and bounded same-origin bundle inspection; no browser runtime oracle was run.",
    "Page hints are sampled and capped to keep the benchmark read-only and bounded.",
  ],
};
await mkdir(outputPath.split("/").slice(0, -1).join("/") || ".", { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
