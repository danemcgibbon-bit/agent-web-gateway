import { fetchUpstream, GatewayError, newCorrelationId, type ConnectorContext } from "./gateway-runtime";

export const WEBMCP_CHECKER_MAX_HTML_BYTES = 1_000_000;
export const WEBMCP_CHECKER_MAX_SCRIPT_BYTES = 500_000;
export const WEBMCP_CHECKER_MAX_SCRIPT_TOTAL_BYTES = 1_500_000;
export const WEBMCP_CHECKER_MAX_SCRIPTS = 6;
// A single outbound page request is bounded to 12s by fetchUpstream. Keep the
// checker window longer than that so a slow-but-healthy origin is not aborted
// before its first response can arrive. Directory and live inspection still
// run in parallel and remain bounded by this one overall deadline.
export const WEBMCP_CHECKER_TIMEOUT_MS = 28_000;
export const WEBMCP_DIRECTORY_ORIGIN = "https://webmcp.com";
export const WEBMCP_DIRECTORY_MAX_BYTES = 750_000;
export const WEBMCP_DIRECTORY_MAX_TOOLS = 40;
export const WEBMCP_DIRECTORY_TIMEOUT_MS = 12_000;

export type WebMcpCheckStatus = "detected" | "possible" | "no_signal" | "disabled" | "unable_to_check";
export type WebMcpCheckConfidence = "high" | "medium" | "low";

export type WebMcpDirectoryTool = {
  name: string;
  description: string;
  kind: "answer" | "act" | "transact" | null;
  impl: "imperative" | "declarative" | null;
  page: string | null;
};

export type WebMcpDirectoryEvidence = {
  status: "verified" | "not_indexed" | "unavailable" | "skipped";
  supported: boolean | null;
  host: string | null;
  matched_host: string | null;
  site_url: string | null;
  site_type: "live" | "demo" | null;
  api_surface: "spec" | "polyfill" | "mixed" | null;
  tool_count: number;
  tools: WebMcpDirectoryTool[];
  pages: string[];
  queried_path: string | null;
  matching_tool_count: number;
  other_tool_pages: string[];
  error_code?: string;
};

export type WebMcpCheckSignals = {
  declarative_tool_count: number;
  imperative_registration_detected: boolean;
  legacy_registration_detected: boolean;
  polyfill_registration_detected: boolean;
  permissions_policy_tools_disabled: boolean;
  webmcp_related_signal: boolean;
};

export type WebMcpCheckInspection = {
  html_checked: boolean;
  same_origin_scripts_checked: number;
  bounded: boolean;
  script_fetch_failures: number;
};

export type WebMcpCheckResult = {
  status: WebMcpCheckStatus;
  confidence: WebMcpCheckConfidence;
  requested_url: string | null;
  final_url: string | null;
  checked_at: string;
  signals: WebMcpCheckSignals;
  inspection: WebMcpCheckInspection;
  recommendation: "prefer_native_webmcp" | "try_agent_web_gateway";
  evidence: string[];
  verification: {
    directory: WebMcpDirectoryEvidence;
    live_scan: {
      status: WebMcpCheckStatus;
      final_url: string | null;
      signals: WebMcpCheckSignals;
      inspection: WebMcpCheckInspection;
      error_code?: string;
    };
  };
  error_code?: string;
};

export type WebMcpCheckOptions = {
  /** Disable the external directory only for controlled benchmarks/fixtures. */
  directory?: boolean;
};

type NormalizedTarget = { url: string; origin: string };
type FetchedText = { text: string; response: Response; url: string };

const EMPTY_SIGNALS: WebMcpCheckSignals = {
  declarative_tool_count: 0,
  imperative_registration_detected: false,
  legacy_registration_detected: false,
  polyfill_registration_detected: false,
  permissions_policy_tools_disabled: false,
  webmcp_related_signal: false,
};

const EMPTY_INSPECTION: WebMcpCheckInspection = {
  html_checked: false,
  same_origin_scripts_checked: 0,
  bounded: true,
  script_fetch_failures: 0,
};

function emptyDirectory(status: WebMcpDirectoryEvidence["status"] = "skipped", error_code?: string): WebMcpDirectoryEvidence {
  return {
    status,
    supported: status === "not_indexed" ? false : null,
    host: null,
    matched_host: null,
    site_url: null,
    site_type: null,
    api_surface: null,
    tool_count: 0,
    tools: [],
    pages: [],
    queried_path: null,
    matching_tool_count: 0,
    other_tool_pages: [],
    ...(error_code ? { error_code } : {}),
  };
}

class CheckerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CheckerError";
    this.code = code;
  }
}

function normalizedHostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isPrivateOrInternalHostname(value: string): boolean {
  const hostname = normalizedHostname(value);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".lan") || hostname.endsWith(".home") || hostname.endsWith(".nip.io") || hostname.endsWith(".sslip.io") || hostname.endsWith(".xip.io") || hostname === "localtest.me" || hostname === "metadata.google.internal" || hostname === "instance-data") return true;
  if (hostname.includes(":")) {
    return hostname === "::1" || hostname === "::" || hostname.startsWith("fc") || hostname.startsWith("fd") || /^fe[89ab]/i.test(hostname) || hostname.startsWith("::ffff:127.") || hostname.startsWith("::ffff:10.") || hostname.startsWith("::ffff:192.168.") || hostname.startsWith("::ffff:169.254.");
  }
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) return !hostname.includes(".");
  const [first, second] = octets.map(Number);
  return first === 0 || first === 10 || first === 127 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 192 && second === 0) || (first === 198 && (second === 18 || second === 19 || second === 51)) || (first === 203 && second === 0) || first >= 224;
}

function normalizeTarget(value: unknown): NormalizedTarget {
  if (typeof value !== "string" || !value.trim() || value.length > 300) throw new CheckerError("INPUT_INVALID", "Enter a public HTTPS website URL.");
  const candidate = value.trim().includes("://") ? value.trim() : `https://${value.trim()}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new CheckerError("INPUT_INVALID", "Enter a valid public HTTPS website URL.");
  }
  const hostname = normalizedHostname(url.hostname);
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || !hostname.includes(".") || isPrivateOrInternalHostname(hostname)) {
    throw new CheckerError("UNSAFE_TARGET", "Only public HTTPS websites can be checked.");
  }
  url.hash = "";
  return { url: url.toString(), origin: url.origin };
}

function requestedCandidate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 300) return null;
  const candidate = value.trim().includes("://") ? value.trim() : "https://" + value.trim();
  try {
    const url = new URL(candidate);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new CheckerError("RESPONSE_TOO_LARGE", "The website response exceeded the checker limit.");

  if (!response.body) {
    const text = await response.text();
    if (byteLength(text) > maxBytes) throw new CheckerError("RESPONSE_TOO_LARGE", "The website response exceeded the checker limit.");
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new CheckerError("RESPONSE_TOO_LARGE", "The website response exceeded the checker limit.");
      }
      chunks.push(decoder.decode(chunk, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

async function fetchBounded(target: string, context: ConnectorContext, allowedOrigin: string, maxBytes: number): Promise<FetchedText> {
  const response = await fetchUpstream(target, context, {
    allowedOrigin,
    accept: "text/html,application/xhtml+xml,application/javascript,text/javascript;q=0.8,*/*;q=0.2",
    headers: { "user-agent": "Agent/AgentWebGateway WebMCP checker (+read-only)" },
    maxRedirects: 3,
  });
  return { text: await readBoundedText(response, maxBytes), response, url: response.url || target };
}

function hasAttribute(attributes: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}(?:\\s|=|$)`, "i").test(attributes);
}

function countDeclarativeTools(html: string): number {
  let count = 0;
  for (const match of html.matchAll(/<form\b([^>]*)>/gi)) {
    const attributes = match[1] ?? "";
    if (hasAttribute(attributes, "toolname") && hasAttribute(attributes, "tooldescription")) count += 1;
  }
  return count;
}

function scriptBlocks(html: string): Array<{ attributes: string; source: string }> {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].map((match) => ({ attributes: match[1] ?? "", source: match[2] ?? "" }));
}

function decodeAttribute(value: string): string {
  return value.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#x27;|&#39;/gi, "'");
}

function discoverScriptUrls(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const urls: string[] = [];
  const attributes = [
    ...scriptBlocks(html).map((block) => block.attributes),
    ...[...html.matchAll(/<link\b([^>]*)>/gi)]
      .map((match) => match[1] ?? "")
      .filter((value) => /\brel\s*=\s*(?:"[^"]*\bmodulepreload\b[^"]*"|'[^']*\bmodulepreload\b[^']*'|[^\s>]*\bmodulepreload\b)/i.test(value)),
  ];
  for (const blockAttributes of attributes) {
    const source = /(?:^|\s)(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(blockAttributes);
    const raw = source?.[1] ?? source?.[2] ?? source?.[3];
    if (!raw) continue;
    try {
      const url = new URL(decodeAttribute(raw), base);
      url.hash = "";
      if (url.protocol !== "https:" || url.origin !== base.origin || url.username || url.password) continue;
      const normalized = url.toString();
      if (!urls.includes(normalized)) urls.push(normalized);
    } catch {
      // Ignore malformed script references; the page itself remains inspectable.
    }
    if (urls.length >= WEBMCP_CHECKER_MAX_SCRIPTS) break;
  }
  return urls;
}

function withoutJavaScriptComments(source: string): string {
  let output = "";
  let quote: string | null = null;
  const templateQuote = String.fromCharCode(96);
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote || character === templateQuote) {
      if (quote) output += character;
      else output += templateQuote;
      if (quote && character === "\\") output += next ?? "";
      if (quote && character === quote && source[index - 1] !== "\\") quote = null;
      if (quote && character === "\\") index += 1;
      if (!quote && character === templateQuote) quote = templateQuote;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
      output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
      output += " ";
      continue;
    }
    output += character;
  }
  return output;
}

function withoutJavaScriptStrings(source: string): string {
  let output = "";
  let quote: string | null = null;
  const templateQuote = String.fromCharCode(96);
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      output += " ";
      continue;
    }
    if (character === "'" || character === "\"" || character === templateQuote) {
      quote = character;
      output += " ";
      continue;
    }
    output += character;
  }
  return output;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function retainWebMcpPropertyLiterals(source: string): string {
  return source.replace(/(\[\s*)(["'])(modelContext|registerTool)\2(?=\s*\])/gi, "$1$3");
}

function registerSignals(source: string): { imperative: boolean; legacy: boolean; polyfill: boolean; related: boolean } {
  const commentFree = withoutJavaScriptComments(source);
  const code = withoutJavaScriptStrings(retainWebMcpPropertyLiterals(commentFree));
  const documentContext = /(?:\b(?:document|window\.document|globalThis\.document)\s*(?:(?:\?\.|\.)\s*modelContext|\[\s*(?:["']?modelContext["']?)\s*\]))/i.test(code);
  const registerToolCall = /\bmodelContext\b\s*(?:\?\.|\.)?\s*(?:registerTool|\[\s*(?:["']?registerTool["']?)\s*\])\s*\(/i.test(code);
  const directImperative = /(?:\b(?:document|window\.document|globalThis\.document)\s*(?:\?\.|\.)?\s*modelContext\s*(?:\?\.|\.)?\s*registerTool|\b(?:document|window\.document|globalThis\.document)\s*\[\s*(?:["']?modelContext["']?)\s*\]\s*(?:\?\.|\.)?\s*(?:registerTool|\[\s*(?:["']?registerTool["']?)\s*\]))\s*\(/i.test(code);
  const aliases = [...code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\b(?:document|window\.document|globalThis\.document)\s*(?:(?:\?\.|\.)\s*modelContext|\[\s*(?:["']?modelContext["']?)\s*\]))/g)].map((match) => match[1]).filter(Boolean);
  const aliasedImperative = aliases.some((alias) => new RegExp(`\\b${escapeRegex(alias)}\\s*(?:\\?\\.|\\.)?\\s*(?:registerTool|\\[\\s*(?:["']?registerTool["']?)\\s*\\])\\s*\\(`, "i").test(code));
  const abstractImperative = (documentContext && registerToolCall) || aliasedImperative;
  const imperative = directImperative || abstractImperative;
  const legacyContext = /\b(?:navigator|window\.navigator|globalThis\.navigator)\s*(?:\?\.|\.)?\s*modelContext\b/i.test(code);
  const legacy = /\b(?:navigator|window\.navigator|globalThis\.navigator)\s*(?:\?\.|\.)?\s*modelContext\s*(?:\?\.|\.)?\s*(?:registerTool|\[\s*["']registerTool["']\s*\])\s*\(/i.test(code);
  const packageReference = /\b(?:import|from|require|exports?\.)\b[^;\n]{0,220}(?:@mcp-b|@webmcp|webmcp(?:[-_/]|\b))/i.test(commentFree);
  const polyfillMarker = /\b(?:initializeWebMCPPolyfill|webmcp-polyfill|mcp-b)\b/i.test(commentFree);
  const polyfill = /\bprovideContext\s*\(/i.test(code) && (packageReference || polyfillMarker);
  const related = documentContext || legacyContext || packageReference || polyfillMarker;
  return { imperative, legacy, polyfill, related };
}

function boundedString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (byteLength(trimmed) <= maxBytes) return trimmed;
  return new TextDecoder().decode(new TextEncoder().encode(trimmed).slice(0, maxBytes));
}

function boundedCount(value: unknown, fallback: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(500, Math.max(0, number));
}

function directoryTool(value: unknown): WebMcpDirectoryTool | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = boundedString(record.name, 120);
  const description = boundedString(record.description, 500) ?? "";
  if (!name) return null;
  const kind = record.kind === "answer" || record.kind === "act" || record.kind === "transact" ? record.kind : null;
  const impl = record.impl === "imperative" || record.impl === "declarative" ? record.impl : null;
  const page = boundedString(record.page, 240);
  return { name, description, kind, impl, page };
}

function normalizeDirectoryPath(value: string): string {
  try {
    const parsed = new URL(value, "https://directory.invalid");
    const path = parsed.pathname || "/";
    return path.length > 1 ? path.replace(/\/+$/, "") : "/";
  } catch {
    return "/";
  }
}

function pageMatchesToolPage(pathname: string, page: string): boolean {
  const normalizedPath = normalizeDirectoryPath(pathname);
  const normalizedPage = normalizeDirectoryPath(page);
  return normalizedPage === "/" ? normalizedPath === "/" : normalizedPath === normalizedPage || normalizedPath.startsWith(`${normalizedPage}/`);
}

function safeDirectorySiteUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || isPrivateOrInternalHostname(parsed.hostname)) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseDirectoryResponse(text: string, targetUrl: string): WebMcpDirectoryEvidence {
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new CheckerError("DIRECTORY_INVALID", "The WebMCP Directory returned invalid JSON.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new CheckerError("DIRECTORY_INVALID", "The WebMCP Directory returned an invalid response.");
  const record = payload as Record<string, unknown>;
  if (record.ok !== true) throw new CheckerError("DIRECTORY_INVALID", "The WebMCP Directory did not confirm a successful lookup.");
  const host = boundedString(record.host, 253);
  if (record.supported === false) {
    return {
      ...emptyDirectory("not_indexed"),
      supported: false,
      host,
      matched_host: boundedString(record.matchedHost, 253),
      queried_path: new URL(targetUrl).pathname || "/",
    };
  }
  if (record.supported !== true || !record.site || typeof record.site !== "object" || Array.isArray(record.site)) throw new CheckerError("DIRECTORY_INVALID", "The WebMCP Directory returned no supported-site record.");
  const site = record.site as Record<string, unknown>;
  const rawTools = Array.isArray(site.tools) ? site.tools : [];
  const tools = rawTools.map(directoryTool).filter((tool): tool is WebMcpDirectoryTool => Boolean(tool)).slice(0, WEBMCP_DIRECTORY_MAX_TOOLS);
  const queriedPath = new URL(targetUrl).pathname || "/";
  const pages = [...new Set(tools.map((tool) => tool.page).filter((page): page is string => Boolean(page)))].slice(0, 24);
  const matchingToolCount = tools.filter((tool) => !tool.page || pageMatchesToolPage(queriedPath, tool.page)).length;
  const otherToolPages = pages.filter((page) => !pageMatchesToolPage(queriedPath, page)).slice(0, 12);
  const apiSurface = site.apiSurface === "spec" || site.apiSurface === "polyfill" || site.apiSurface === "mixed" ? site.apiSurface : null;
  const siteType = site.type === "live" || site.type === "demo" ? site.type : null;
  const toolCount = boundedCount(site.toolCount, tools.length);
  if (toolCount === 0 && tools.length === 0) throw new CheckerError("DIRECTORY_INVALID", "The WebMCP Directory returned a supported site without tools.");
  return {
    status: "verified",
    supported: true,
    host: host ?? boundedString(site.host, 253),
    matched_host: boundedString(record.matchedHost, 253),
    site_url: safeDirectorySiteUrl(site.url),
    site_type: siteType,
    api_surface: apiSurface,
    tool_count: toolCount,
    tools,
    pages,
    queried_path: queriedPath,
    matching_tool_count: matchingToolCount,
    other_tool_pages: otherToolPages,
  };
}

function forkContext(context: ConnectorContext, timeoutMs: number): { context: ConnectorContext; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (context.signal.aborted) controller.abort();
  else context.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    context: { ...context, signal: controller.signal },
    cleanup: () => {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", abort);
    },
  };
}

async function lookupDirectory(target: NormalizedTarget, context: ConnectorContext): Promise<WebMcpDirectoryEvidence> {
  const fork = forkContext(context, WEBMCP_DIRECTORY_TIMEOUT_MS);
  try {
    const directoryUrl = new URL("/api/v1/lookup", WEBMCP_DIRECTORY_ORIGIN);
    directoryUrl.searchParams.set("url", target.url);
    const response = await fetchBounded(directoryUrl.toString(), fork.context, WEBMCP_DIRECTORY_ORIGIN, WEBMCP_DIRECTORY_MAX_BYTES);
    return parseDirectoryResponse(response.text, target.url);
  } catch (error) {
    return emptyDirectory("unavailable", errorCode(error));
  } finally {
    fork.cleanup();
  }
}

function finalUrlFor(result: FetchedText, requested: string): string {
  try {
    const candidate = new URL(result.url || requested);
    if (candidate.protocol !== "https:" || candidate.username || candidate.password || isPrivateOrInternalHostname(candidate.hostname)) return requested;
    candidate.hash = "";
    return candidate.toString();
  } catch {
    return requested;
  }
}

function errorCode(error: unknown): string {
  if (error instanceof CheckerError) return error.code;
  if (error instanceof GatewayError) return error.code;
  if (error instanceof DOMException && error.name === "AbortError") return "UPSTREAM_TIMEOUT";
  return "UNABLE_TO_CHECK";
}

type LiveScanResult = {
  status: WebMcpCheckStatus;
  final_url: string | null;
  signals: WebMcpCheckSignals;
  inspection: WebMcpCheckInspection;
  evidence: string[];
  error_code?: string;
};

function liveFailure(code: string): LiveScanResult {
  return {
    status: "unable_to_check",
    final_url: null,
    signals: { ...EMPTY_SIGNALS },
    inspection: { ...EMPTY_INSPECTION },
    evidence: [],
    error_code: code,
  };
}

async function inspectLive(target: NormalizedTarget, context: ConnectorContext): Promise<LiveScanResult> {
  try {
    const homepage = await fetchBounded(target.url, context, target.origin, WEBMCP_CHECKER_MAX_HTML_BYTES);
    const finalUrl = finalUrlFor(homepage, target.url);
    const permissionsDisabled = /\btools\s*=\s*\(\s*\)/i.test(homepage.response.headers.get("permissions-policy") ?? "");
    const declarativeCount = countDeclarativeTools(homepage.text);
    const blocks = scriptBlocks(homepage.text);
    let imperative = false;
    let legacy = false;
    let polyfill = false;
    let related = false;
    for (const block of blocks) {
      const signals = registerSignals(block.source);
      imperative ||= signals.imperative;
      legacy ||= signals.legacy;
      polyfill ||= signals.polyfill;
      related ||= signals.related;
    }

    const scriptUrls = declarativeCount > 0 || imperative || legacy || polyfill ? [] : discoverScriptUrls(homepage.text, finalUrl);
    let scriptsChecked = 0;
    let scriptFailures = 0;
    let totalScriptBytes = 0;
    let reservedScriptBytes = 0;
    for (let index = 0; index < scriptUrls.length; index += 2) {
      const batch = scriptUrls.slice(index, index + 2);
      const results = await Promise.all(batch.map(async (url) => {
        const remainingBudget = WEBMCP_CHECKER_MAX_SCRIPT_TOTAL_BYTES - reservedScriptBytes;
        if (remainingBudget <= 0) return { ok: false as const };
        const budget = Math.min(WEBMCP_CHECKER_MAX_SCRIPT_BYTES, remainingBudget);
        reservedScriptBytes += budget;
        try {
          const bundle = await fetchBounded(url, context, target.origin, budget);
          totalScriptBytes += byteLength(bundle.text);
          const signals = registerSignals(bundle.text);
          return { ok: true as const, signals };
        } catch {
          return { ok: false as const };
        }
      }));
      for (const result of results) {
        if (!result.ok) {
          scriptFailures += 1;
          continue;
        }
        scriptsChecked += 1;
        imperative ||= result.signals.imperative;
        legacy ||= result.signals.legacy;
        polyfill ||= result.signals.polyfill;
        related ||= result.signals.related;
      }
      if (totalScriptBytes >= WEBMCP_CHECKER_MAX_SCRIPT_TOTAL_BYTES || context.signal.aborted) break;
    }
    if (context.signal.aborted) throw new CheckerError("UPSTREAM_TIMEOUT", "The live inspection exceeded the checker time limit.");

    const detected = declarativeCount > 0 || imperative || legacy || polyfill;
    const possible = !detected && related;
    const status: WebMcpCheckStatus = permissionsDisabled ? "disabled" : detected ? "detected" : possible ? "possible" : "no_signal";
    const evidence = [
      ...(declarativeCount > 0 ? [`${declarativeCount} declarative WebMCP form${declarativeCount === 1 ? "" : "s"} found`] : []),
      ...(imperative ? ["document.modelContext.registerTool detected"] : []),
      ...(legacy ? ["navigator.modelContext.registerTool detected"] : []),
      ...(polyfill ? ["WebMCP polyfill registration detected"] : []),
      ...(permissionsDisabled ? ["Permissions-Policy disables tools on this response"] : []),
      ...(possible ? ["WebMCP-related runtime code found without a provable registration call"] : []),
    ];
    return {
      status,
      final_url: finalUrl,
      signals: {
        declarative_tool_count: declarativeCount,
        imperative_registration_detected: imperative,
        legacy_registration_detected: legacy,
        polyfill_registration_detected: polyfill,
        permissions_policy_tools_disabled: permissionsDisabled,
        webmcp_related_signal: related,
      },
      inspection: { html_checked: true, same_origin_scripts_checked: Math.min(scriptsChecked, WEBMCP_CHECKER_MAX_SCRIPTS), bounded: true, script_fetch_failures: scriptFailures },
      evidence,
    };
  } catch (error) {
    return liveFailure(errorCode(error));
  }
}

function directoryEvidenceText(directory: WebMcpDirectoryEvidence): string[] {
  if (directory.status === "verified") {
    const toolLabel = `${directory.tool_count} cataloged tool${directory.tool_count === 1 ? "" : "s"}`;
    const pageLabel = directory.pages.length > 1 ? ` across ${directory.pages.length} pages` : "";
    return [
      `Verified in the Agent Web Gateway catalog (${toolLabel}${pageLabel})`,
      ...(directory.other_tool_pages.length > 0 ? [`Tools are also cataloged on: ${directory.other_tool_pages.slice(0, 4).join(", ")}`] : []),
    ];
  }
  if (directory.status === "not_indexed") return ["No matching site record was found in the Agent Web Gateway catalog; this is not proof that the site lacks WebMCP."];
  if (directory.status === "unavailable") return ["The Agent Web Gateway catalog could not be reached; the result uses independent inspection only."];
  return [];
}

function failureResult(requestedUrl: string | null, code: string): WebMcpCheckResult {
  const directory = emptyDirectory("skipped");
  const live = liveFailure(code);
  return {
    status: "unable_to_check",
    confidence: "low",
    requested_url: requestedUrl,
    final_url: null,
    checked_at: new Date().toISOString(),
    signals: live.signals,
    inspection: live.inspection,
    recommendation: "try_agent_web_gateway",
    evidence: [],
    verification: { directory, live_scan: live },
    error_code: code,
  };
}

export async function checkWebMcp(value: unknown, externalSignal?: AbortSignal, options: WebMcpCheckOptions = {}): Promise<WebMcpCheckResult> {
  let target: NormalizedTarget;
  try {
    target = normalizeTarget(value);
  } catch (error) {
    return failureResult(requestedCandidate(value), errorCode(error));
  }

  const controller = new AbortController();
  const abortExternal = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", abortExternal, { once: true });
  const timer = setTimeout(() => controller.abort(), WEBMCP_CHECKER_TIMEOUT_MS);
  const context: ConnectorContext = {
    signal: controller.signal,
    correlationId: newCorrelationId(),
    startedAt: new Date().toISOString(),
  };

  try {
    const directoryPromise = options.directory === false ? Promise.resolve(emptyDirectory("skipped")) : lookupDirectory(target, context);
    const livePromise = inspectLive(target, context);
    const [directory, live] = await Promise.all([directoryPromise, livePromise]);
    const directoryVerified = directory.status === "verified" && directory.supported === true;
    const liveDetected = live.status === "detected";
    const status: WebMcpCheckStatus = directoryVerified || liveDetected
      ? "detected"
      : live.status === "disabled"
        ? "disabled"
        : live.status === "possible"
          ? "possible"
          : live.status === "no_signal"
            ? "no_signal"
            : "unable_to_check";
    const confidence: WebMcpCheckConfidence = directoryVerified || liveDetected || status === "disabled" ? "high" : status === "possible" ? "medium" : "low";
    const evidence = [
      ...(directory.status === "unavailable" && live.status === "unable_to_check" ? [] : directoryEvidenceText(directory)),
      ...live.evidence,
      ...(directoryVerified && live.status === "unable_to_check" ? ["The directory verified this site even though the live static scan was unavailable."] : []),
    ];
    const verification = {
      directory,
      live_scan: {
        status: live.status,
        final_url: live.final_url,
        signals: live.signals,
        inspection: live.inspection,
        ...(live.error_code ? { error_code: live.error_code } : {}),
      },
    };
    return {
      status,
      confidence,
      requested_url: target.url,
      final_url: live.final_url,
      checked_at: new Date().toISOString(),
      signals: live.signals,
      inspection: live.inspection,
      recommendation: status === "detected" ? "prefer_native_webmcp" : "try_agent_web_gateway",
      evidence,
      verification,
      ...(status === "unable_to_check" ? { error_code: live.error_code ?? (directory.status === "unavailable" ? directory.error_code : undefined) } : {}),
    };
  } catch (error) {
    return failureResult(target.url, errorCode(error));
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortExternal);
  }
}
