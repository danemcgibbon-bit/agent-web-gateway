import assert from "node:assert/strict";
import test from "node:test";

const { compatibilityBenchmarkReport, compatibilityBenchmarkSummary } = await import("../lib/compatibility-benchmark.ts");
const { COMPATIBILITY_BENCHMARK_TARGETS, SHOPIFY_BENCHMARK_TARGETS, WOOCOMMERCE_BENCHMARK_TARGETS } = await import("../lib/compatibility-benchmark-targets.ts");
const { TOOL_DEFINITIONS } = await import("../lib/gateway-contract.ts");
const { GET } = await import("../app/api/compatibility/route.ts");

test("v0.11 benchmark report is machine-readable and target-bounded", async () => {
  const report = compatibilityBenchmarkReport();
  assert.equal(report.schema_version, "0.11");
  assert.equal(report.methodology.public_https_only, true);
  assert.equal(report.methodology.read_only, true);
  assert.equal(report.methodology.zero_configuration, true);
  assert.equal(SHOPIFY_BENCHMARK_TARGETS.length, 10);
  assert.equal(WOOCOMMERCE_BENCHMARK_TARGETS.length, 10);
  assert.equal(COMPATIBILITY_BENCHMARK_TARGETS.length, 20);
  assert.equal(TOOL_DEFINITIONS.length, 24);
  assert.equal(compatibilityBenchmarkSummary().status, "complete");
});

test("v0.11 compatibility endpoint exposes the detailed report without adding tools", async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.schema_version, "0.11");
  assert.ok(Array.isArray(report.reconnaissance));
  assert.ok(Array.isArray(report.unified_benchmarks));
  assert.ok(Array.isArray(report.canonical_demos));
});
