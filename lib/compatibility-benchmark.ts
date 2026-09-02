import report from "../data/compatibility-benchmark.json";
import type { JsonObject } from "./gateway-contract";

export function compatibilityBenchmarkReport(): JsonObject {
  return report as JsonObject;
}

export function compatibilityBenchmarkSummary(): JsonObject {
  const value = compatibilityBenchmarkReport();
  const families = value.families && typeof value.families === "object" && !Array.isArray(value.families) ? value.families as JsonObject : {};
  return {
    status: value.status ?? "not_run",
    generated_at: value.generated_at ?? null,
    families: Object.fromEntries(Object.entries(families).map(([name, family]) => {
      const item = family && typeof family === "object" && !Array.isArray(family) ? family as JsonObject : {};
      return [name, {
        tested_sites: item.tested_sites ?? 0,
        search_success_rate: item.search_success_rate ?? 0,
        detail_success_rate: item.detail_success_rate ?? 0,
        chain_success_rate: item.chain_success_rate ?? 0,
        generic_reuse_rate: item.generic_reuse_rate ?? 0,
        false_success_count: item.false_success_count ?? 0,
        maturity: item.maturity ?? "unavailable",
      }];
    })),
  };
}
