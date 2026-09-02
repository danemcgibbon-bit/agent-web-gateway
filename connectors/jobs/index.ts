import type { JsonObject } from "../../lib/gateway-contract";
import {
  createExecutionTrace,
  fetchJson,
  GatewayError,
  type ConnectorContext,
  type ConnectorExecution,
  type ExecutionTrace,
  type GatewayErrorCode,
  type SiteConnector,
} from "../../lib/gateway-runtime";
import {
  firstNumber,
  firstString,
  sanitizeText,
  slugify,
} from "../../lib/upstream-parser";
import { recordExtractionBenchmark } from "../../lib/extraction-benchmark";
import { rememberRecipe } from "../../lib/embedded-state";

export type JobPlatform = "greenhouse" | "lever";

export type JobBoardDefinition = {
  platform: JobPlatform;
  company: string;
  name: string;
  board_token: string;
  enabled: boolean;
};

/**
 * Fixed public board catalog. A request may select a known company, or the
 * gateway searches a bounded subset of the catalog. It never turns arbitrary
 * caller input into a remote URL.
 */
export const JOB_BOARD_CATALOG = [
  { platform: "greenhouse", company: "stripe", name: "Stripe", board_token: "stripe", enabled: true },
  { platform: "greenhouse", company: "figma", name: "Figma", board_token: "figma", enabled: true },
  { platform: "greenhouse", company: "lyft", name: "Lyft", board_token: "lyft", enabled: true },
  { platform: "greenhouse", company: "coinbase", name: "Coinbase", board_token: "coinbase", enabled: true },
  { platform: "greenhouse", company: "gitlab", name: "GitLab", board_token: "gitlab", enabled: true },
  { platform: "lever", company: "binance", name: "Binance", board_token: "binance", enabled: true },
  { platform: "lever", company: "deliverect", name: "Deliverect", board_token: "deliverect", enabled: true },
  { platform: "lever", company: "farfetch", name: "Farfetch", board_token: "farfetch", enabled: true },
  { platform: "lever", company: "qonto", name: "Qonto", board_token: "qonto", enabled: true },
  { platform: "lever", company: "zartis", name: "Zartis", board_token: "zartis", enabled: true },
] as const satisfies readonly JobBoardDefinition[];

const MAX_JOB_BOARDS_PER_SEARCH = 6;
const MAX_SOURCE_JOBS = 180;
const MAX_DESCRIPTION_LENGTH = 800;
const LEVER_SEARCH_PAGE_SIZE = 20;

type JobRecord = JsonObject;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function stringValue(value: unknown, maxLength = 240): string | null {
  return sanitizeText(value, maxLength);
}

function normalized(value: unknown): string {
  return stringValue(value, 500)?.toLowerCase().replace(/\s+/g, " ").trim() ?? "";
}

function tokenList(value: unknown): string[] {
  return [...new Set(normalized(value).split(/[^a-z0-9]+/).filter((token) => token.length >= 2))];
}

function numericId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === "string" && value.trim() && value.trim().length <= 180) return value.trim();
  return null;
}

function dateValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function firstArrayObject(value: unknown): JsonObject | null {
  if (!Array.isArray(value)) return null;
  return object(value[0]);
}

function metadataValue(job: JsonObject, pattern: RegExp): unknown {
  if (!Array.isArray(job.metadata)) return null;
  for (const raw of job.metadata) {
    const item = object(raw);
    const label = firstString(item?.name, item?.label, item?.key, item?.title);
    if (label && pattern.test(label)) return item?.value ?? item?.content ?? null;
  }
  return null;
}

function salaryFrom(value: unknown): JsonObject | null {
  const item = object(value);
  if (item) {
    const min = firstNumber(item.min, item.minimum, item.minValue, item.low, item.from);
    const max = firstNumber(item.max, item.maximum, item.maxValue, item.high, item.to);
    const amount = firstNumber(item.amount, item.value);
    const currency = (firstString(item.currency, item.currencyCode, item.currency_code) ?? "GBP").toUpperCase();
    const interval = firstString(item.interval, item.period, item.payPeriod, item.frequency);
    if (min !== null || max !== null) {
      const lower = min ?? max;
      const upper = max ?? min;
      if (lower !== null && upper !== null && lower >= 0 && upper >= lower) {
        return { min: lower, max: upper, currency, ...(interval ? { interval } : {}) };
      }
    }
    if (amount !== null && amount >= 0) return { amount, currency, ...(interval ? { interval } : {}) };
  }
  if (typeof value !== "string") return null;
  const text = sanitizeText(value, 240);
  if (!text) return null;
  const currencyMatch = /(?:£|GBP|EUR|USD|\$|€)\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi;
  const amounts = [...text.matchAll(currencyMatch)]
    .map((match) => Number((match[1] ?? "").replace(/,/g, "")))
    .filter((amount) => Number.isFinite(amount) && amount >= 0);
  if (!amounts.length) return null;
  const currency = /€|EUR/i.test(text) ? "EUR" : /\$|USD/i.test(text) ? "USD" : "GBP";
  const interval = /(?:per|\/)\s*(year|annum|month|hour)/i.exec(text)?.[1] ?? null;
  return amounts.length > 1
    ? { min: Math.min(...amounts), max: Math.max(...amounts), currency, ...(interval ? { interval } : {}) }
    : { amount: amounts[0], currency, ...(interval ? { interval } : {}) };
}

function salaryValue(job: JsonObject): JsonObject | null {
  const direct = salaryFrom(job.salaryRange ?? job.salary_range ?? job.salary ?? job.compensation);
  if (direct) return direct;
  return salaryFrom(metadataValue(job, /salary|compensation|pay|remuneration/i));
}

function explicitRemote(job: JsonObject, location: string | null): boolean | null {
  if (typeof job.remote === "boolean") return job.remote;
  if (typeof job.is_remote === "boolean") return job.is_remote;
  const workplace = firstString(job.workplaceType, job.workplace_type, job.remoteType);
  if (workplace && /remote/i.test(workplace)) return true;
  if (workplace && /on[-\s]?site|office/i.test(workplace)) return false;
  if (location && /\bremote\b/i.test(location)) return true;
  if (location && /\bon[-\s]?site\b|\bin office\b/i.test(location)) return false;
  return null;
}

function locationValue(job: JsonObject, categories: JsonObject | null): string | null {
  const locationObject = object(job.location);
  return firstString(
    locationObject?.name,
    locationObject?.display_name,
    typeof job.location === "string" ? job.location : null,
    categories?.location,
    categories?.locations,
    firstArrayObject(job.offices)?.name,
    firstArrayObject(job.offices)?.location,
  );
}

function listText(job: JsonObject, keys: string[]): string | null {
  for (const key of keys) {
    const value = job[key];
    if (Array.isArray(value)) {
      const first = firstArrayObject(value);
      const result = firstString(first?.name, first?.value, first?.label);
      if (result) return result;
    } else {
      const result = firstString(value);
      if (result) return result;
    }
  }
  return null;
}

function publicJobUrl(board: JobBoardDefinition, value: unknown, rawId: string): string {
  const fallback = board.platform === "greenhouse"
    ? "https://job-boards.greenhouse.io/" + board.company + "/jobs/" + encodeURIComponent(rawId)
    : "https://jobs.lever.co/" + board.company + "/" + encodeURIComponent(rawId);
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    const valid = board.platform === "greenhouse"
      ? (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io")
        && path.includes("/" + board.company + "/jobs/" + rawId.toLowerCase())
      : host === "jobs.lever.co"
        && path.startsWith("/" + board.company + "/" + rawId.toLowerCase());
    if (!valid) return fallback;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

function normalizeJob(raw: unknown, board: JobBoardDefinition): JobRecord | null {
  const job = object(raw);
  if (!job) return null;
  const rawId = numericId(job.id ?? job.job_id ?? job.jobId);
  const categories = object(job.categories);
  const title = firstString(job.title, job.text, job.name);
  if (!rawId || !title || title.length < 3) return null;
  const location = locationValue(job, categories);
  const description = firstString(job.descriptionPlain, job.description_plain, job.description, job.content, job.description_html);
  const department = listText(job, ["department", "departments"]) ?? firstString(categories?.department);
  const team = listText(job, ["team", "teams"]) ?? firstString(categories?.team);
  const employmentType = firstString(
    job.employment_type,
    job.employmentType,
    job.commitment,
    categories?.commitment,
    categories?.employment_type,
  );
  const canonicalUrl = publicJobUrl(
    board,
    job.absolute_url ?? job.absoluteUrl ?? job.hostedUrl ?? job.hosted_url ?? job.url,
    rawId,
  );
  const id = board.platform + ":" + board.company + ":" + rawId;
  return {
    provider: board.platform,
    platform: board.platform,
    job_id: id,
    source_job_id: rawId,
    company: board.name,
    company_slug: board.company,
    title: title.slice(0, 260),
    location,
    remote: explicitRemote(job, location),
    department,
    team,
    employment_type: employmentType,
    description_summary: description ? description.slice(0, MAX_DESCRIPTION_LENGTH) : null,
    salary: salaryValue(job),
    published_at: dateValue(job.published_at ?? job.publishedAt ?? job.created_at ?? job.createdAt),
    updated_at: dateValue(job.updated_at ?? job.updatedAt),
    canonical_url: canonicalUrl,
    retrieved_at: new Date().toISOString(),
    execution_mode: "public_http",
  };
}

function apiUrl(board: JobBoardDefinition, rawId?: string, includeContent = Boolean(rawId)): string {
  if (board.platform === "greenhouse") {
    return "https://boards-api.greenhouse.io/v1/boards/" + board.board_token + "/jobs"
      + (rawId ? "/" + encodeURIComponent(rawId) : "")
      + "?content=" + (includeContent ? "true" : "false");
  }
  return "https://api.lever.co/v0/postings/" + board.board_token
    + (rawId ? "/" + encodeURIComponent(rawId) : "")
    + "?mode=json" + (rawId ? "" : "&limit=" + LEVER_SEARCH_PAGE_SIZE);
}

function rowsFrom(value: unknown, platform: JobPlatform): unknown[] {
  if (Array.isArray(value)) return value.slice(0, MAX_SOURCE_JOBS);
  const item = object(value);
  const rows = item?.jobs ?? item?.postings ?? item?.results;
  if (Array.isArray(rows)) return rows.slice(0, MAX_SOURCE_JOBS);
  throw new GatewayError("UPSTREAM_CHANGED", "The " + platform + " public jobs endpoint returned an unexpected shape.", {
    retryable: true,
    mode: "public_http",
    stage: "http",
  });
}

function queryMatches(job: JobRecord, input: JsonObject): boolean {
  const query = tokenList(input.query);
  const haystack = normalized([
    job.title,
    job.company,
    job.location,
    job.department,
    job.team,
    job.description_summary,
  ].filter(Boolean).join(" "));
  if (query.length && !query.every((token) => haystack.includes(token))) return false;
  const location = tokenList(input.location);
  const jobLocation = normalized(job.location);
  if (location.length && (!jobLocation || !location.every((token) => jobLocation.includes(token)))) return false;
  if (typeof input.remote === "boolean" && job.remote !== input.remote) return false;
  const department = tokenList(input.department);
  if (department.length && (!normalized(job.department) || !department.every((token) => normalized(job.department).includes(token)))) return false;
  const employmentType = tokenList(input.employment_type);
  if (employmentType.length && (!normalized(job.employment_type) || !employmentType.every((token) => normalized(job.employment_type).includes(token)))) return false;
  return true;
}

function relevanceScore(job: JobRecord, input: JsonObject): number {
  const query = tokenList(input.query);
  const title = normalized(job.title);
  const description = normalized(job.description_summary);
  return query.reduce((score, token) => score + (title.includes(token) ? 10 : description.includes(token) ? 3 : 0), 0)
    + (job.location ? 1 : 0)
    + (job.salary ? 1 : 0)
    + (job.remote === true ? 1 : 0);
}

function rankJobs(jobs: JobRecord[], input: JsonObject): JobRecord[] {
  const dateScore = (job: JobRecord): number => Date.parse(String(job.updated_at ?? job.published_at ?? "")) || 0;
  const titleScore = (job: JobRecord): string => String(job.title ?? "");
  const sorted = [...jobs];
  if (input.sort_by === "date_desc") sorted.sort((a, b) => (dateScore(b) - dateScore(a)) || titleScore(a).localeCompare(titleScore(b)));
  else if (input.sort_by === "title_asc") sorted.sort((a, b) => titleScore(a).localeCompare(titleScore(b)) || String(a.job_id).localeCompare(String(b.job_id)));
  else sorted.sort((a, b) => (relevanceScore(b, input) - relevanceScore(a, input)) || (dateScore(b) - dateScore(a)) || String(a.job_id).localeCompare(String(b.job_id)));
  return sorted;
}

function resultLimit(input: JsonObject): number {
  return typeof input.max_results === "number" ? Math.min(20, Math.max(1, input.max_results)) : 10;
}

function errorInfo(error: unknown): JsonObject {
  if (error instanceof GatewayError) {
    return { status: "error", code: error.code, message: error.message, retryable: error.retryable };
  }
  return { status: "error", code: "INTERNAL_ERROR", message: "The public jobs board could not complete the request.", retryable: true };
}

function rememberJobRecipe(board: JobBoardDefinition, capability: "search" | "detail"): void {
  rememberRecipe({
    domain: board.platform + ":" + board.company,
    capability: "jobs." + capability,
    execution_mode: "public_http",
    engine: board.platform,
    request: {
      method: "GET",
      url_template: capability === "search"
        ? apiUrl(board)
        : board.platform === "greenhouse"
          ? "https://boards-api.greenhouse.io/v1/boards/" + board.board_token + "/jobs/{job_id}?content=true"
          : "https://api.lever.co/v0/postings/" + board.board_token + "/{job_id}?mode=json",
    },
    parser: "jobs_" + board.platform + "_shared_v1",
    validator: "validJobListing",
    last_verified_at: new Date().toISOString(),
    shared_code: ["connectors/jobs/index.ts", "semantic-validation.ts", "gateway-runtime.ts"],
  });
}

function observationTrace(outcome: "success" | "zero_results" | "error", errorCode?: GatewayErrorCode): ExecutionTrace {
  const trace = createExecutionTrace();
  trace.http = {
    attempted: true,
    outcome: outcome === "error" ? "failed" : "success",
    ...(errorCode ? { error_code: errorCode } : {}),
  };
  trace.semantic_validation = {
    attempted: true,
    outcome: outcome === "error" ? "failed" : "success",
    ...(errorCode ? { error_code: errorCode } : {}),
  };
  trace.fallback = {
    eligible: false,
    attempted: false,
    from: "http",
    outcome: "skipped",
    reason: "no_alternate_zero_config_route",
    ...(errorCode ? { error_code: errorCode } : {}),
  };
  return trace;
}

function observe(
  context: ConnectorContext,
  board: JobBoardDefinition,
  tool: string,
  startedAt: string,
  outcome: "success" | "zero_results" | "error",
  errorCode?: GatewayErrorCode,
): void {
  context.onProviderObservation?.({
    provider: "jobs",
    upstream_provider: board.platform,
    tool,
    startedAt,
    mode: "public_http",
    outcome,
    ...(errorCode ? { errorCode } : {}),
    trace: observationTrace(outcome, errorCode),
  });
}

async function listBoard(board: JobBoardDefinition, context: ConnectorContext): Promise<{ jobs: JobRecord[]; url: string }> {
  const result = await fetchJson(apiUrl(board, undefined, false), context);
  const rawRows = rowsFrom(result.value, board.platform);
  const jobs = rawRows.map((raw) => normalizeJob(raw, board)).filter((job): job is JobRecord => Boolean(job));
  if (rawRows.length > 0 && !jobs.length) {
    throw new GatewayError("UPSTREAM_CHANGED", "The " + board.platform + " public jobs endpoint returned no valid job records.", {
      retryable: true,
      mode: "public_http",
      sourceUrl: result.url,
      stage: "semantic",
    });
  }
  recordExtractionBenchmark({
    provider: board.platform + ":" + board.company,
    surface: "search",
    engine: board.platform,
    records: rawRows,
    validRecords: jobs,
    idField: "job_id",
    fields: ["id", "title", "location", "remote", "department", "employment_type", "description_summary", "salary", "canonical_url"],
    startedAt: context.startedAt,
    extractionStrategy: board.platform + "_public_api",
  });
  rememberJobRecipe(board, "search");
  return { jobs, url: result.url };
}

async function detailBoard(board: JobBoardDefinition, rawId: string, context: ConnectorContext): Promise<{ job: JobRecord; url: string; route: string }> {
  let directError: unknown;
  try {
    const result = await fetchJson(apiUrl(board, rawId), context);
    const job = normalizeJob(result.value, board);
    if (!job || String(job.source_job_id) !== rawId) {
      throw new GatewayError("UPSTREAM_CHANGED", "The " + board.platform + " detail endpoint did not return the requested job.", {
        retryable: true,
        mode: "public_http",
        sourceUrl: result.url,
        stage: "semantic",
      });
    }
    recordExtractionBenchmark({
      provider: board.platform + ":" + board.company,
      surface: "detail",
      engine: board.platform,
      records: [result.value],
      validRecords: [job],
      expectedId: job.job_id as string,
      idField: "job_id",
      fields: ["id", "title", "location", "remote", "department", "employment_type", "description_summary", "salary", "canonical_url"],
      startedAt: context.startedAt,
      extractionStrategy: board.platform + "_public_api_detail",
    });
    rememberJobRecipe(board, "detail");
    return { job, url: result.url, route: board.platform + "_public_api" };
  } catch (error) {
    directError = error;
  }
  if (directError instanceof GatewayError && ["NOT_FOUND", "UPSTREAM_CHANGED"].includes(directError.code)) {
    try {
      const listed = await listBoard(board, context);
      const job = listed.jobs.find((candidate) => String(candidate.source_job_id) === rawId);
      if (job) {
        recordExtractionBenchmark({
          provider: board.platform + ":" + board.company,
          surface: "detail",
          engine: board.platform,
          records: [job],
          validRecords: [job],
          expectedId: job.job_id as string,
          idField: "job_id",
          fields: ["id", "title", "location", "remote", "department", "employment_type", "description_summary", "salary", "canonical_url"],
          startedAt: context.startedAt,
          extractionStrategy: board.platform + "_public_api_search_fallback",
        });
        rememberJobRecipe(board, "detail");
        return { job, url: listed.url, route: board.platform + "_public_api_search_fallback" };
      }
    } catch {
      // Preserve the direct detail failure when the bounded fallback cannot help.
    }
  }
  throw directError;
}

function selectedBoards(company: unknown): JobBoardDefinition[] {
  const enabled = JOB_BOARD_CATALOG.filter((board) => board.enabled);
  if (typeof company !== "string" || !company.trim()) {
    return [
      ...enabled.filter((board) => board.platform === "greenhouse").slice(0, 3),
      ...enabled.filter((board) => board.platform === "lever").slice(0, 3),
    ].slice(0, MAX_JOB_BOARDS_PER_SEARCH);
  }
  const needle = slugify(company);
  const matches = enabled.filter((board) => board.company === needle || slugify(board.name) === needle || board.name.toLowerCase().includes(company.trim().toLowerCase()));
  if (!matches.length) {
    throw new GatewayError("CONNECTOR_UNAVAILABLE", "The requested company is not in the gateway's bounded public jobs catalog.", {
      retryable: false,
      mode: "public_http",
    });
  }
  return matches;
}

function platformStatus(rows: Array<{ board: JobBoardDefinition; jobs?: JobRecord[]; error?: unknown }>): JsonObject {
  const output: JsonObject = {};
  for (const platform of ["greenhouse", "lever"] as const) {
    const platformRows = rows.filter((row) => row.board.platform === platform);
    const successful = platformRows.filter((row) => row.jobs);
    const errors = platformRows.filter((row) => row.error);
    const jobs = successful.flatMap((row) => row.jobs ?? []);
    output[platform] = {
      status: jobs.length ? (errors.length ? "partial" : "success") : errors.length ? (successful.length ? "partial" : "error") : "zero_results",
      boards_attempted: platformRows.length,
      boards_with_results: platformRows.filter((row) => (row.jobs?.length ?? 0) > 0).length,
      result_count: jobs.length,
      ...(errors.length && errors[0]?.error instanceof GatewayError ? { code: errors[0].error.code } : {}),
      ...(errors.length ? { failures: errors.map((row) => ({ company: row.board.company, ...errorInfo(row.error) })) } : {}),
    };
  }
  return output;
}

async function searchJobs(input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const boards = selectedBoards(input.company);
  const settled = await Promise.all(boards.map(async (board) => {
    const startedAt = new Date().toISOString();
    try {
      const listed = await listBoard(board, context);
      observe(context, board, "search", startedAt, listed.jobs.length ? "success" : "zero_results");
      return { board, jobs: listed.jobs, url: listed.url };
    } catch (error) {
      const gatewayError = error instanceof GatewayError ? error : new GatewayError("INTERNAL_ERROR", "The public jobs board could not complete the request.", { retryable: true, mode: "public_http", cause: error });
      observe(context, board, "search", startedAt, "error", gatewayError.code);
      return { board, error: gatewayError };
    }
  }));
  const normalizedRows = settled.map((row) => ({
    board: row.board,
    jobs: row.jobs,
    error: row.error,
    url: row.url,
  }));
  const allJobs = normalizedRows.flatMap((row) => (row.jobs ?? []).filter((job) => queryMatches(job, input)));
  const results = rankJobs(allJobs, input).slice(0, resultLimit(input));
  const successfulRows = normalizedRows.filter((row) => row.jobs);
  if (!results.length && !successfulRows.length) {
    const firstError = normalizedRows.find((row) => row.error)?.error;
    throw firstError instanceof GatewayError ? firstError : new GatewayError("UPSTREAM_CHANGED", "No public jobs board returned a usable response.", { retryable: true, mode: "public_http" });
  }
  const sourceUrl = normalizedRows.find((row) => row.url)?.url ?? "https://boards-api.greenhouse.io";
  const platforms = [...new Set(normalizedRows.map((row) => row.board.platform))];
  const providerDiagnostics: JsonObject = {};
  for (const row of normalizedRows) {
    providerDiagnostics[row.board.platform + ":" + row.board.company] = row.error
      ? errorInfo(row.error)
      : {
        status: row.jobs?.length ? "success" : "zero_results",
        platform: row.board.platform,
        company: row.board.name,
        result_count: row.jobs?.length ?? 0,
        route: row.board.platform + "_public_api",
      };
  }
  return {
    data: {
      query: input.query ?? null,
      location: input.location ?? null,
      results,
      coverage: platformStatus(normalizedRows),
      diagnostics: {
        boards_attempted: boards.map((board) => ({ platform: board.platform, company: board.company })),
        catalog_size: JOB_BOARD_CATALOG.length,
        provider_diagnostics: providerDiagnostics,
        platform_families: platforms,
      },
    },
    sourceUrl,
    sourceProvider: "Jobs (Greenhouse and Lever)",
    mode: "public_http",
    engine: platforms.length === 1 ? platforms[0] : "greenhouse+lever",
    retrievedAt: new Date().toISOString(),
    outcome: results.length ? "SUCCESS" : "ZERO_RESULTS",
  };
}

function boardFromCanonical(provider: JobPlatform, value: unknown): JobBoardDefinition | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    if (provider === "greenhouse" && (url.hostname === "boards.greenhouse.io" || url.hostname === "job-boards.greenhouse.io")) {
      const company = segments[0];
      return JOB_BOARD_CATALOG.find((board) => board.platform === provider && board.company === company) ?? null;
    }
    if (provider === "lever" && url.hostname === "jobs.lever.co") {
      const company = segments[0];
      return JOB_BOARD_CATALOG.find((board) => board.platform === provider && board.company === company) ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

function boardAndRawId(input: JsonObject): { board: JobBoardDefinition; rawId: string } {
  const provider = input.provider as JobPlatform;
  const rawInput = String(input.job_id ?? "").trim();
  const composite = new RegExp("^" + provider + ":([^:]+):(.+)$", "i").exec(rawInput);
  const companyPrefix = /^([^:]+):(.+)$/.exec(rawInput);
  const canonicalBoard = boardFromCanonical(provider, input.canonical_url);
  let board: JobBoardDefinition | undefined = canonicalBoard ?? undefined;
  if (!board && typeof input.company === "string") {
    board = selectedBoards(input.company).find((candidate) => candidate.platform === provider);
  }
  if (!board && composite) {
    board = JOB_BOARD_CATALOG.find((candidate) => candidate.platform === provider && candidate.company === composite[1].toLowerCase());
  }
  if (!board && companyPrefix) {
    board = JOB_BOARD_CATALOG.find((candidate) => candidate.platform === provider && candidate.company === companyPrefix[1].toLowerCase());
  }
  if (!board) {
    throw new GatewayError("INPUT_INVALID", "jobs_get_listing needs a supported company, canonical public job URL, or gateway-issued composite job_id.", {
      retryable: false,
      mode: "public_http",
    });
  }
  const rawId = composite?.[2] ?? (companyPrefix?.[1].toLowerCase() === board.company ? companyPrefix[2] : rawInput);
  if (!rawId || rawId.length > 180 || /[/?#\s]/.test(rawId)) {
    throw new GatewayError("INPUT_INVALID", "job_id is not a valid public job identifier.", { retryable: false, mode: "public_http" });
  }
  return { board, rawId };
}

async function getJob(input: JsonObject, context: ConnectorContext): Promise<ConnectorExecution> {
  const { board, rawId } = boardAndRawId(input);
  const startedAt = new Date().toISOString();
  try {
    const detail = await detailBoard(board, rawId, context);
    observe(context, board, "get_listing", startedAt, "success");
    return {
      data: {
        listing: detail.job,
        diagnostics: { platform: board.platform, company: board.name, route: detail.route, identity_verified: true },
      },
      sourceUrl: detail.url,
      sourceProvider: board.name + " (" + board.platform + ")",
      mode: "public_http",
      engine: board.platform,
      retrievedAt: new Date().toISOString(),
      outcome: "SUCCESS",
    };
  } catch (error) {
    const gatewayError = error instanceof GatewayError ? error : new GatewayError("INTERNAL_ERROR", "The public job listing could not complete the request.", { retryable: true, mode: "public_http", cause: error });
    observe(context, board, "get_listing", startedAt, "error", gatewayError.code);
    throw gatewayError;
  }
}

export const jobsConnector: SiteConnector = {
  provider: "jobs",
  async execute(tool, input, context): Promise<ConnectorExecution> {
    if (tool === "search") return searchJobs(input, context);
    if (tool === "get_listing") return getJob(input, context);
    throw new GatewayError("CONNECTOR_UNAVAILABLE", "Jobs does not implement " + tool + ".");
  },
};
