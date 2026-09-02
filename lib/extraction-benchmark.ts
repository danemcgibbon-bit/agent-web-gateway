import type { JsonObject } from "./gateway-contract";
import { detectFrameworks, extractEmbeddedState } from "./embedded-state";

export type BenchmarkSurface = "search" | "detail" | "recon";

export type ExtractionBenchmark = {
  provider: string;
  surface: BenchmarkSurface;
  engine?: string;
  recorded_at: string;
  latency_ms: number | null;
  frameworks_detected: string[];
  embedded_state_kinds: string[];
  candidate_count: number;
  valid_record_count: number;
  field_completeness: Record<string, number>;
  id_chain: "verified" | "not_applicable" | "not_verified";
  false_success_count: number;
  extraction_strategy?: string;
};

export type BenchmarkInput = {
  provider: string;
  surface: BenchmarkSurface;
  html?: string;
  records: unknown[];
  validRecords?: unknown[];
  validator?: (value: unknown) => boolean;
  idField?: string;
  expectedId?: string;
  fields?: string[];
  startedAt?: string;
  extractionStrategy?: string;
  engine?: string;
};

const DEFAULT_FIELDS = ["id", "title", "price", "rating", "review_count", "image_url", "canonical_url"];
const MAX_ROWS = 200;
const rows: ExtractionBenchmark[] = [];

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function present(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function fieldValue(record: JsonObject, field: string): unknown {
  if (field === "id") return record.product_id ?? record.item_id ?? record.listing_id ?? record.hotel_id ?? record.flight_id ?? record.job_id ?? record.id ?? record.asin;
  if (field === "title") return record.title ?? record.name;
  return record[field];
}

function latency(startedAt?: string): number | null {
  if (!startedAt) return null;
  const timestamp = Date.parse(startedAt);
  return Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : null;
}

export function benchmarkExtraction(input: BenchmarkInput): ExtractionBenchmark {
  const html = typeof input.html === "string" ? input.html : "";
  const framework = html ? detectFrameworks(html) : { frameworks: [], rendering: "unknown", signals: [] };
  const states = html ? extractEmbeddedState(html) : [];
  const records = input.records.slice(0, MAX_ROWS);
  const validRecords = (input.validRecords ?? (input.validator ? records.filter(input.validator) : records)).slice(0, MAX_ROWS);
  const fields = input.fields?.length ? input.fields.slice(0, 20) : DEFAULT_FIELDS;
  const completeness: Record<string, number> = {};
  for (const field of fields) {
    const count = validRecords.reduce<number>((total, value) => total + (object(value) && present(fieldValue(object(value)!, field)) ? 1 : 0), 0);
    completeness[field] = validRecords.length ? Math.round((count / validRecords.length) * 1000) / 1000 : 0;
  }
  const idField = input.idField ?? "id";
  const expected = input.expectedId;
  const idChain: ExtractionBenchmark["id_chain"] = expected
    ? validRecords.some((value) => String(fieldValue(object(value) ?? {}, idField) ?? "") === expected) ? "verified" : "not_verified"
    : input.surface === "detail" ? "not_verified" : "not_applicable";
  return {
    provider: input.provider,
    surface: input.surface,
    ...(input.engine ? { engine: input.engine } : {}),
    recorded_at: new Date().toISOString(),
    latency_ms: latency(input.startedAt),
    frameworks_detected: framework.frameworks,
    embedded_state_kinds: [...new Set(states.map((state) => state.kind))],
    candidate_count: records.length,
    valid_record_count: validRecords.length,
    field_completeness: completeness,
    id_chain: idChain,
    false_success_count: Math.max(0, records.length - validRecords.length),
    ...(input.extractionStrategy ? { extraction_strategy: input.extractionStrategy } : {}),
  };
}

export function recordExtractionBenchmark(input: BenchmarkInput | ExtractionBenchmark): ExtractionBenchmark {
  const row = "recorded_at" in input ? input : benchmarkExtraction(input);
  rows.push(row);
  while (rows.length > MAX_ROWS) rows.shift();
  return row;
}

function average(values: number[]): number | null {
  return values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000 : null;
}

export function benchmarkSummary(): JsonObject {
  const byProvider: JsonObject = {};
  for (const provider of [...new Set(rows.map((row) => row.provider))]) {
    const providerRows = rows.filter((row) => row.provider === provider);
    const successful = providerRows.filter((row) => row.valid_record_count > 0);
    const searchRows = providerRows.filter((row) => row.surface === "search");
    const detailRows = providerRows.filter((row) => row.surface === "detail");
    const chainRows = providerRows.filter((row) => row.id_chain !== "not_applicable");
    const completenessByField: Record<string, number[]> = {};
    for (const row of providerRows) {
      for (const [field, value] of Object.entries(row.field_completeness)) {
        (completenessByField[field] ??= []).push(value);
      }
    }
    const averageFields = Object.fromEntries(Object.entries(completenessByField).map(([field, values]) => [field, average(values)]));
    const candidateCount = providerRows.reduce((sum, row) => sum + row.candidate_count, 0);
    const completenessValues = providerRows.flatMap((row) => Object.values(row.field_completeness));
    byProvider[provider] = {
      samples: providerRows.length,
      successful_samples: successful.length,
      success_rate: providerRows.length ? Math.round((successful.length / providerRows.length) * 1000) / 1000 : null,
      search_samples: searchRows.length,
      search_successful_samples: searchRows.filter((row) => row.valid_record_count > 0).length,
      search_success_rate: searchRows.length ? Math.round((searchRows.filter((row) => row.valid_record_count > 0).length / searchRows.length) * 1000) / 1000 : null,
      detail_samples: detailRows.length,
      detail_successful_samples: detailRows.filter((row) => row.valid_record_count > 0).length,
      detail_success_rate: detailRows.length ? Math.round((detailRows.filter((row) => row.valid_record_count > 0).length / detailRows.length) * 1000) / 1000 : null,
      field_completeness: averageFields,
      price_completeness: typeof averageFields.price === "number" ? averageFields.price : null,
      id_chain_samples: chainRows.length,
      id_chain_verified: chainRows.filter((row) => row.id_chain === "verified").length,
      id_chain_success_rate: chainRows.length ? Math.round((chainRows.filter((row) => row.id_chain === "verified").length / chainRows.length) * 1000) / 1000 : null,
      candidate_count: candidateCount,
      average_field_completeness: average(completenessValues),
      false_success_count: providerRows.reduce((sum, row) => sum + row.false_success_count, 0),
      false_success_rate: candidateCount ? Math.round((providerRows.reduce((sum, row) => sum + row.false_success_count, 0) / candidateCount) * 1000) / 1000 : 0,
      frameworks: [...new Set(providerRows.flatMap((row) => row.frameworks_detected))],
      embedded_state_kinds: [...new Set(providerRows.flatMap((row) => row.embedded_state_kinds))],
      engines: [...new Set(providerRows.map((row) => row.engine).filter((value): value is string => Boolean(value)))],
      last_sample_at: providerRows.at(-1)?.recorded_at ?? null,
    };
  }
  return {
    retained: rows.length,
    false_success_count: rows.reduce((sum, row) => sum + row.false_success_count, 0),
    by_provider: byProvider,
  };
}

export function resetBenchmark(): void {
  rows.length = 0;
}
