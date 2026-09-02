import { mkdir, writeFile } from "node:fs/promises";
import {
  agentEvalReport,
  evaluateJourney,
  GOLDEN_JOURNEYS,
  type AgentToolCall,
  type AgentTrace,
  type GoldenJourney,
} from "../lib/agent-evals";
import {
  AGENT_QUICKSTART,
  GATEWAY_VERSION,
  PREFERRED_SEMANTIC_TOOL_NAMES,
  toolsForSurface,
  type JsonObject,
} from "../lib/gateway-contract";

type Surface = "full" | "semantic";
type InterfaceVariant = "legacy_full" | "lean_tools" | "lean_deterministic" | "lean_deterministic_advanced";
type ModelConfig = { label: string; model: string };
type GuidanceMode = "minimal" | "instructional";

const INTERFACE_VARIANTS: Array<{ id: InterfaceVariant; surface: Surface; toolNames: string[]; guidance: GuidanceMode }> = [
  { id: "legacy_full", surface: "full", guidance: "minimal", toolNames: toolsForSurface("full").map((tool) => tool.name) },
  { id: "lean_tools", surface: "semantic", guidance: "minimal", toolNames: PREFERRED_SEMANTIC_TOOL_NAMES.filter((name) => !["gateway_find_tool", "gateway_call_tool"].includes(name)) },
  { id: "lean_deterministic", surface: "semantic", guidance: "instructional", toolNames: PREFERRED_SEMANTIC_TOOL_NAMES.filter((name) => !["gateway_find_tool", "gateway_call_tool"].includes(name)) },
  { id: "lean_deterministic_advanced", surface: "semantic", guidance: "instructional", toolNames: [...PREFERRED_SEMANTIC_TOOL_NAMES] },
];

const gatewayUrl = (process.env.AGENT_EVAL_GATEWAY_URL ?? "https://agent-web-gateway.djrookie99.chatgpt.site").replace(/\/$/, "");
const endpoint = process.env.AGENT_EVAL_MODEL_ENDPOINT ?? "https://api.openai.com/v1/chat/completions";
const apiKey = process.env.AGENT_EVAL_API_KEY;
const trials = Math.max(1, Math.min(10, Number.parseInt(process.env.AGENT_EVAL_TRIALS ?? "5", 10) || 5));
const maxTurns = Math.max(2, Math.min(12, Number.parseInt(process.env.AGENT_EVAL_MAX_TURNS ?? "8", 10) || 8));
const outputPath = process.argv[2] ?? `data/agent-evals-v${GATEWAY_VERSION}.json`;

async function writeReport(report: JsonObject): Promise<void> {
  const directory = outputPath.split("/").slice(0, -1).join("/") || ".";
  await mkdir(directory, { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function configuredModels(): ModelConfig[] {
  const raw = process.env.AGENT_EVAL_MODELS ?? "";
  const parsed = raw.split(/[,;]+/).map((item) => item.trim()).filter(Boolean).map((item) => {
    const [label, ...rest] = item.split("=");
    return { label: label?.trim() || "model", model: rest.join("=").trim() || label?.trim() || "" };
  }).filter((item) => item.model);
  if (parsed.length) return parsed;
  const defaults = [
    ["GPT-5.6-Luna", process.env.AGENT_EVAL_GPT56_LUNA_MODEL ?? process.env.AGENT_EVAL_STRONG_MODEL],
    ["DeepSeek-V4-Flash", process.env.AGENT_EVAL_DEEPSEEK_V4_FLASH_MODEL ?? process.env.AGENT_EVAL_CHEAP_MODEL],
  ] as const;
  return defaults.flatMap(([label, model]) => model ? [{ label, model }] : []);
}

function openAiTools(availableTools?: Set<string>, guidance: GuidanceMode = "instructional"): JsonObject[] {
  return toolsForSurface("full")
    .filter((tool) => !availableTools || availableTools.has(tool.name))
    .map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: guidance === "instructional" ? tool.description : tool.title,
      parameters: tool.inputSchema,
    },
  }));
}

function toolResultUrl(tool: string, args: JsonObject): string | null {
  if (tool === "gateway_capabilities") {
    const params = new URLSearchParams({ capability: typeof args.capability === "string" ? args.capability : "all" });
    for (const key of ["scope", "goal", "level"] as const) if (typeof args[key] === "string") params.set(key, args[key] as string);
    return `${gatewayUrl}/api/capabilities?${params.toString()}`;
  }
  if (tool === "gateway_status") return `${gatewayUrl}/api/status`;
  if (tool === "gateway_manifest") {
    const params = new URLSearchParams({ surface: args.surface === "semantic" ? "semantic" : "full" });
    if (typeof args.site === "string") params.set("site", args.site);
    if (typeof args.query === "string") params.set("query", args.query);
    return `${gatewayUrl}/api/manifest?${params.toString()}`;
  }
  return null;
}

async function invokeGateway(tool: string, args: JsonObject): Promise<{ payload: unknown; status: number; latencyMs: number }> {
  const startedAt = Date.now();
  const callTool = async (operation: string, argumentsValue: JsonObject): Promise<{ payload: unknown; status: number; latencyMs: number }> => {
    const response = await fetch(`${gatewayUrl}/api/call-tool`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ operation, arguments: argumentsValue }),
      signal: AbortSignal.timeout(45_000),
    });
    return { payload: await response.json(), status: response.status, latencyMs: Date.now() - startedAt };
  };
  if (tool === "gateway_find_tool") {
    const params = new URLSearchParams({ query: typeof args.query === "string" ? args.query : "" });
    if (typeof args.scope === "string") params.set("scope", args.scope);
    if (typeof args.max_results === "number") params.set("max_results", String(args.max_results));
    const response = await fetch(`${gatewayUrl}/api/find-tool?${params.toString()}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(45_000) });
    return { payload: await response.json(), status: response.status, latencyMs: Date.now() - startedAt };
  }
  if (tool === "gateway_task") {
    const response = await fetch(`${gatewayUrl}/api/task`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(45_000),
    });
    return { payload: await response.json(), status: response.status, latencyMs: Date.now() - startedAt };
  }
  if (tool === "gateway_call_tool") {
    return callTool(String(args.operation ?? ""), object(args.arguments) ?? {});
  }
  if (tool === "gateway_echo") return callTool("gateway_echo", args);
  if (tool === "commerce_platform_diagnostics") return callTool("commerce_platform_diagnostics", args);
  const readUrl = toolResultUrl(tool, args);
  if (readUrl) {
    const response = await fetch(readUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(45_000) });
    return { payload: await response.json(), status: response.status, latencyMs: Date.now() - startedAt };
  }
  // Keep the evaluation path on the same registry dispatch used by the
  // page-mediated agent surface; /api/execute remains an implementation
  // endpoint and is never presented as a normal agent action.
  return callTool(tool, args);
}

function safeContent(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized.length > 60_000 ? serialized.slice(0, 59_997) + "..." : serialized;
}

function expansionResult(scope: unknown): { payload: JsonObject; toolNames: string[] } {
  const normalized = typeof scope === "string" ? scope : "";
  const toolNames: string[] = [];
  return {
    toolNames,
    payload: {
      gateway_version: GATEWAY_VERSION,
      provider: "gateway",
      tool: "expand_tools",
      status: "error",
      answer_ready: true,
      next_action: null,
      error: { code: "INPUT_INVALID", message: "gateway_expand_tools is deprecated; use gateway_find_tool followed by gateway_call_tool.", retryable: false },
      data: {
        scope: normalized,
        deprecated: true,
        requested_tool_names: [],
        registered_tool_names: [...PREFERRED_SEMANTIC_TOOL_NAMES],
        discovered_tool_names: [...PREFERRED_SEMANTIC_TOOL_NAMES],
        registered_tool_count: toolNames.length,
        registration_state: "static_core_bootstrap",
        message: "The fixed WebMCP surface is registered at startup; use strict metadata discovery and exact dispatch for advanced operations.",
      },
    },
  };
}

function traceFrom(calls: AgentToolCall[], messages: string[], outputs: unknown[]): AgentTrace {
  const errors = calls.filter((call) => call.status === "error");
  const successful = calls.filter((call) => call.status === "success");
  const lastError = errors.at(-1);
  const coverage: JsonObject = {};
  for (const output of outputs) {
    const item = object(output);
    const itemCoverage = object(item?.coverage);
    if (itemCoverage) Object.assign(coverage, itemCoverage);
  }
  return {
    calls,
    final_status: errors.length && successful.length ? "partial" : errors.length ? "error" : "success",
    ...(lastError?.error_code ? { final_error_code: lastError.error_code } : {}),
    final_message: messages.at(-1) ?? "",
    ...(Object.keys(coverage).length ? { coverage } : {}),
  };
}

async function runTrial(journey: GoldenJourney, variant: { id: InterfaceVariant; surface: Surface; toolNames: string[]; guidance: GuidanceMode }, model: ModelConfig): Promise<JsonObject> {
  const startedAt = Date.now();
  const messages: JsonObject[] = [
    { role: "system", content: variant.guidance === "instructional"
      ? `Complete the user's request with the available read-only tools. Do not invent facts. Use this gateway quickstart: ${JSON.stringify(AGENT_QUICKSTART)}. For a normal request, call gateway_task with the user's request in goal, then follow its agent_action. If it returns answer or report_partial, stop; if it returns follow_next_action, execute next_action exactly; if it returns clarify, ask the returned clarification. Use specialist tools only when you need explicit control. Do not call gateway_manifest or any implementation endpoint, and do not browse storefront APIs directly.`
      : "Complete the user's request with the available read-only tools. Do not invent facts. Use the smallest suitable registered tool, stop when the result is answer-ready, and do not browse storefront APIs directly." },
    { role: "user", content: journey.user_request },
  ];
  const calls: AgentToolCall[] = [];
  const outputs: unknown[] = [];
  const availableTools = new Set(variant.toolNames);
  let schemaCharactersSent = 0;
  let outputCharacters = 0;
  let largestResponseCharacters = 0;
  let gatewayExecutionMs = 0;
  let firstCorrectSemanticCallMs: number | null = null;
  let toolErrors = 0;
  let modelTurns = 0;
  let expansionCount = 0;
  let contextOverflowCount = 0;
  const tokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let tokenUsageObserved = false;
  let maxVisibleTools = availableTools.size;
  let finalMessage = "";
  let requestError: string | null = null;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    modelTurns = turn + 1;
    const toolDefinitions = openAiTools(availableTools, variant.guidance);
    schemaCharactersSent += JSON.stringify(toolDefinitions).length;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model: model.model, messages, tools: toolDefinitions, tool_choice: "auto", temperature: 0 }),
      signal: AbortSignal.timeout(90_000),
    });
    const responseText = await response.text();
    let body: unknown;
    try { body = JSON.parse(responseText) as unknown; } catch { body = { error: { message: responseText } }; }
    if (!response.ok) {
      requestError = `model_http_${response.status}`;
      if (response.status === 400 || response.status === 413 || /context|token|too long|payload/i.test(responseText)) contextOverflowCount += 1;
      break;
    }
    const responseObject = object(body);
    const usage = object(responseObject?.usage);
    if (usage) {
      for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
        if (typeof usage[key] === "number" && Number.isFinite(usage[key])) tokenUsage[key] += usage[key] as number;
      }
      tokenUsageObserved = true;
    }
    const choices = Array.isArray(responseObject?.choices) ? responseObject.choices : [];
    const choice = object(choices[0]);
    const message = object(choice?.message);
    if (!message) {
      requestError = "model_response_missing_message";
      break;
    }
    const content = typeof message.content === "string" ? message.content : "";
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (content) finalMessage = content;
    if (!toolCalls.length) break;
    messages.push({ role: "assistant", content: content || null, tool_calls: toolCalls });
    for (const rawCall of toolCalls) {
      const call = object(rawCall);
      const functionCall = object(call?.function);
      const name = typeof functionCall?.name === "string" ? functionCall.name : "unknown_tool";
      let args: JsonObject = {};
      try {
        const parsed: unknown = JSON.parse(typeof functionCall?.arguments === "string" ? functionCall.arguments : "{}");
        args = object(parsed) ?? {};
      } catch {
        calls.push({ tool: name, arguments: {}, status: "error", error_code: "INVALID_MODEL_ARGUMENTS" });
        toolErrors += 1;
        messages.push({ role: "tool", tool_call_id: String(call?.id ?? "unknown"), content: JSON.stringify({ status: "error", error: { code: "INVALID_MODEL_ARGUMENTS", message: "Tool arguments were not valid JSON." } }) });
        continue;
      }
      if (!availableTools.has(name)) {
        calls.push({ tool: name, arguments: args, status: "error", error_code: "TOOL_NOT_IN_SURFACE" });
        toolErrors += 1;
        messages.push({ role: "tool", tool_call_id: String(call?.id ?? "unknown"), content: JSON.stringify({ status: "error", error: { code: "TOOL_NOT_IN_SURFACE", message: "That tool is not available in this discovery surface." } }) });
        continue;
      }
      try {
        const result = await (name === "gateway_expand_tools"
          ? (() => {
            const expansion = expansionResult(args.scope);
            for (const toolName of expansion.toolNames) availableTools.add(toolName);
            expansionCount += 1;
            maxVisibleTools = Math.max(maxVisibleTools, availableTools.size);
            return Promise.resolve({ payload: expansion.payload, status: 200, latencyMs: 0 });
          })()
          : invokeGateway(name, args));
        const payload = result.payload;
        outputs.push(payload);
        const payloadCharacters = JSON.stringify(payload).length;
        outputCharacters += payloadCharacters;
        largestResponseCharacters = Math.max(largestResponseCharacters, payloadCharacters);
        gatewayExecutionMs += result.latencyMs;
        const payloadObject = object(payload);
        const errorCode = object(payloadObject?.error)?.code;
        const callStatus = result.status >= 400 || typeof errorCode === "string" ? "error" : "success";
        if (callStatus === "error") toolErrors += 1;
        if (callStatus === "success" && name === journey.expected_primary_tool && firstCorrectSemanticCallMs === null) firstCorrectSemanticCallMs = Date.now() - startedAt;
        calls.push({ tool: name, arguments: args, status: callStatus, ...(typeof errorCode === "string" ? { error_code: errorCode } : {}) });
        messages.push({ role: "tool", tool_call_id: String(call?.id ?? "unknown"), content: safeContent(payload) });
      } catch {
        calls.push({ tool: name, arguments: args, status: "error", error_code: "GATEWAY_REQUEST_FAILED" });
        toolErrors += 1;
        messages.push({ role: "tool", tool_call_id: String(call?.id ?? "unknown"), content: JSON.stringify({ status: "error", error: { code: "GATEWAY_REQUEST_FAILED", message: "The gateway request failed." } }) });
      }
    }
  }
  const trace = traceFrom(calls, [finalMessage], outputs);
  const evaluation = evaluateJourney(journey, trace);
  const finalPayload = object(outputs.at(-1));
  const finalData = object(finalPayload?.data);
  const countTool = (name: string): number => calls.filter((call) => call.tool === name).length;
  const detailCallCount = calls.filter((call) => call.tool.includes("get_")).length;
  const nonWebMcpCalls = calls.filter((call) => /^(browser|exec|curl|fetch|http|web_search)/i.test(call.tool));
  const webmcpOnlyCompletion = evaluation.journey_completion === true
    && !requestError
    && nonWebMcpCalls.length === 0;
  return {
    journey_id: journey.id,
    variant: variant.id,
    surface: variant.surface,
    model: model.label,
    model_id: model.model,
    ...(requestError ? { request_error: requestError } : {}),
    call_count: calls.length,
    first_correct_tool: evaluation.tool_selection.passed,
    capability_call_count: countTool("gateway_capabilities"),
    manifest_call_count: countTool("gateway_manifest"),
    advanced_expansion_call_count: countTool("gateway_expand_tools"),
    advanced_discovery_call_count: countTool("gateway_find_tool"),
    advanced_dispatch_call_count: countTool("gateway_call_tool"),
    detail_call_count: detailCallCount,
    discovery_count: countTool("gateway_capabilities") + countTool("gateway_manifest") + countTool("gateway_expand_tools") + countTool("gateway_find_tool") + countTool("gateway_call_tool"),
    latency_ms: Date.now() - startedAt,
    total_agent_ms: Date.now() - startedAt,
    model_turns: modelTurns,
    tool_errors: toolErrors,
    first_correct_semantic_call_ms: firstCorrectSemanticCallMs,
    gateway_execution_ms: gatewayExecutionMs,
    largest_response_characters: largestResponseCharacters,
    schema_characters_sent: schemaCharactersSent,
    estimated_schema_tokens_sent: Math.ceil(schemaCharactersSent / 4),
    output_characters: outputCharacters,
    estimated_output_tokens: Math.ceil(outputCharacters / 4),
    expansion_count: expansionCount,
    max_visible_tool_count: maxVisibleTools,
    context_overflow_count: contextOverflowCount,
    answer_ready: typeof finalPayload?.answer_ready === "boolean" ? finalPayload.answer_ready : typeof finalData?.answer_ready === "boolean" ? finalData.answer_ready : null,
    agent_action: typeof finalPayload?.agent_action === "string" ? finalPayload.agent_action : typeof finalData?.agent_action === "string" ? finalData.agent_action : null,
    answer_state: typeof finalData?.answer_state === "string" ? finalData.answer_state : null,
    coverage_level: typeof finalData?.coverage_level === "string" ? finalData.coverage_level : null,
    coverage_sufficient_for_superlative: typeof finalData?.coverage_sufficient_for_superlative === "boolean" ? finalData.coverage_sufficient_for_superlative : null,
    direct_api_fallback: false,
    webmcp_only_completion: webmcpOnlyCompletion,
    token_usage: tokenUsageObserved ? tokenUsage : null,
    trace,
    evaluation,
  };
}

function aggregate(rows: JsonObject[]): JsonObject {
  const evaluations = rows.map((row) => object(row.evaluation)).filter((value): value is JsonObject => Boolean(value));
  const rate = (key: string): number => evaluations.length ? Math.round((evaluations.filter((evaluation) => object(evaluation[key])?.passed === true).length / evaluations.length) * 1000) / 1000 : 0;
  const completed = evaluations.filter((evaluation) => evaluation.journey_completion === true).length;
  const calls = rows.map((row) => typeof row.call_count === "number" ? row.call_count : 0);
  const latencies = rows.map((row) => typeof row.latency_ms === "number" ? row.latency_ms : 0);
  const schemaCharacters = rows.map((row) => typeof row.schema_characters_sent === "number" ? row.schema_characters_sent : 0);
  const schemaTokens = rows.map((row) => typeof row.estimated_schema_tokens_sent === "number" ? row.estimated_schema_tokens_sent : 0);
  const outputCharacters = rows.map((row) => typeof row.output_characters === "number" ? row.output_characters : 0);
  const modelTurns = rows.map((row) => typeof row.model_turns === "number" ? row.model_turns : 0);
  const toolErrors = rows.map((row) => typeof row.tool_errors === "number" ? row.tool_errors : 0);
  const firstCorrectCall = rows.map((row) => typeof row.first_correct_semantic_call_ms === "number" ? row.first_correct_semantic_call_ms : 0).filter((value) => value > 0);
  const gatewayExecution = rows.map((row) => typeof row.gateway_execution_ms === "number" ? row.gateway_execution_ms : 0);
  const largestResponses = rows.map((row) => typeof row.largest_response_characters === "number" ? row.largest_response_characters : 0);
  const expansions = rows.map((row) => typeof row.expansion_count === "number" ? row.expansion_count : 0);
  const contextOverflows = rows.reduce((sum, row) => sum + (typeof row.context_overflow_count === "number" ? row.context_overflow_count : 0), 0);
  const usageRows = rows.map((row) => object(row.token_usage)).filter((value): value is JsonObject => Boolean(value));
  const webmcpOnlyCompletions = rows.filter((row) => row.webmcp_only_completion === true).length;
  return {
    trials: rows.length,
    journey_completion: evaluations.length ? Math.round((completed / evaluations.length) * 1000) / 1000 : 0,
    tool_understanding_accuracy: rate("tool_understanding"),
    tool_selection_accuracy: rate("tool_selection"),
    argument_accuracy: rate("argument_extraction"),
    chain_completion_accuracy: rate("chain_completion"),
    failure_handling_accuracy: rate("failure_handling"),
    forbidden_outcome_safety: rate("forbidden_outcomes"),
    diagnostic_tool_misuse_free_rate: rate("diagnostic_tool_misuse"),
    unnecessary_call_free_rate: rate("unnecessary_tool_calls"),
    average_tool_calls: calls.length ? Math.round((calls.reduce((sum, value) => sum + value, 0) / calls.length) * 100) / 100 : 0,
    average_latency_ms: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : 0,
    average_schema_characters_sent: schemaCharacters.length ? Math.round(schemaCharacters.reduce((sum, value) => sum + value, 0) / schemaCharacters.length) : 0,
    average_schema_tokens_sent: schemaTokens.length ? Math.round(schemaTokens.reduce((sum, value) => sum + value, 0) / schemaTokens.length) : 0,
    average_output_characters: outputCharacters.length ? Math.round(outputCharacters.reduce((sum, value) => sum + value, 0) / outputCharacters.length) : 0,
    average_model_turns: modelTurns.length ? Math.round((modelTurns.reduce((sum, value) => sum + value, 0) / modelTurns.length) * 100) / 100 : 0,
    average_tool_errors: toolErrors.length ? Math.round((toolErrors.reduce((sum, value) => sum + value, 0) / toolErrors.length) * 100) / 100 : 0,
    average_time_to_first_correct_semantic_call_ms: firstCorrectCall.length ? Math.round(firstCorrectCall.reduce((sum, value) => sum + value, 0) / firstCorrectCall.length) : null,
    average_gateway_execution_ms: gatewayExecution.length ? Math.round(gatewayExecution.reduce((sum, value) => sum + value, 0) / gatewayExecution.length) : 0,
    largest_response_characters: largestResponses.length ? Math.max(...largestResponses) : 0,
    expansion_usage_rate: expansions.length ? Math.round((expansions.filter((value) => value > 0).length / expansions.length) * 1000) / 1000 : 0,
    context_overflow_count: contextOverflows,
    answer_ready_rate: rows.length ? Math.round((rows.filter((row) => row.answer_ready === true).length / rows.length) * 1000) / 1000 : 0,
    partial_coverage_rate: rows.length ? Math.round((rows.filter((row) => row.answer_state === "partial").length / rows.length) * 1000) / 1000 : 0,
    direct_api_fallback_count: rows.filter((row) => row.direct_api_fallback === true).length,
    webmcp_only_completion_count: webmcpOnlyCompletions,
    webmcp_only_completion_rate: rows.length ? Math.round((webmcpOnlyCompletions / rows.length) * 1000) / 1000 : 0,
    token_usage: usageRows.length ? {
      prompt_tokens: usageRows.reduce((sum, usage) => sum + (typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0), 0),
      completion_tokens: usageRows.reduce((sum, usage) => sum + (typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0), 0),
      total_tokens: usageRows.reduce((sum, usage) => sum + (typeof usage.total_tokens === "number" ? usage.total_tokens : 0), 0),
    } : null,
    false_success_count: falseSuccessCount(rows),
  };
}

function efficiencyBenchmark(rows: JsonObject[]): JsonObject {
  const toolCount = (name: string): number => rows.reduce((sum, row) => {
    const trace = object(row.trace);
    const calls = Array.isArray(trace?.calls) ? trace.calls : [];
    return sum + calls.filter((call) => object(call)?.tool === name).length;
  }, 0);
  const metric = (key: string): number => rows.reduce((sum, row) => sum + (typeof row[key] === "number" ? row[key] as number : 0), 0);
  const firstCorrect = rows.filter((row) => object(object(row.evaluation)?.tool_selection)?.passed === true).length;
  return {
    trials: rows.length,
    first_correct_tool_rate: rows.length ? Math.round((firstCorrect / rows.length) * 1000) / 1000 : 0,
    average_tool_calls: rows.length ? Math.round((metric("call_count") / rows.length) * 100) / 100 : 0,
    capability_calls: toolCount("gateway_capabilities"),
    manifest_calls: toolCount("gateway_manifest"),
    advanced_expansion_calls: toolCount("gateway_expand_tools"),
    advanced_discovery_calls: toolCount("gateway_find_tool"),
    advanced_dispatch_calls: toolCount("gateway_call_tool"),
    detail_calls: rows.reduce((sum, row) => {
      const trace = object(row.trace);
      const calls = Array.isArray(trace?.calls) ? trace.calls : [];
      return sum + calls.filter((call) => typeof object(call)?.tool === "string" && String(object(call)?.tool).includes("get_")).length;
    }, 0),
    output_characters: metric("output_characters"),
    schema_context_characters: metric("schema_characters_sent"),
    elapsed_ms: metric("latency_ms"),
    gateway_execution_ms: metric("gateway_execution_ms"),
    model_turns: metric("model_turns"),
    tool_errors: metric("tool_errors"),
    largest_response_characters: rows.reduce((max, row) => Math.max(max, typeof row.largest_response_characters === "number" ? row.largest_response_characters : 0), 0),
    context_overflow_count: metric("context_overflow_count"),
    webmcp_only_completion_rate: rows.length ? Math.round((rows.filter((row) => row.webmcp_only_completion === true).length / rows.length) * 1000) / 1000 : 0,
  };
}

function falseSuccessCount(rows: JsonObject[]): number {
  return rows.filter((row) => {
    const journey = GOLDEN_JOURNEYS.find((item) => item.id === row.journey_id);
    const trace = object(row.trace);
    return Boolean(journey && ["unsupported_site", "detail_failure_honest", "failure_distinguished"].includes(journey.scenario) && trace?.final_status === "success");
  }).length;
}

async function main(): Promise<void> {
  const models = configuredModels();
  if (!models.length) {
    const report = {
      ...agentEvalReport(),
      generated_at: new Date().toISOString(),
      status: "not_run",
      webmcp_agent_evals: {
        status: "not_run",
        reason: "Set AGENT_EVAL_MODELS or AGENT_EVAL_GPT56_LUNA_MODEL/AGENT_EVAL_DEEPSEEK_V4_FLASH_MODEL and AGENT_EVAL_MODEL_ENDPOINT to run repeated trials.",
        runner: "scripts/run-agent-evals.ts",
        models: [],
        repeated_trials_target: trials,
        variants: Object.fromEntries(INTERFACE_VARIANTS.map((variant) => [variant.id, { surface: variant.surface, guidance: variant.guidance, tool_count: variant.toolNames.length }])),
      },
    };
    await writeReport(report);
    console.log(JSON.stringify({ status: "not_run", output: outputPath, reason: report.webmcp_agent_evals.reason }, null, 2));
    return;
  }
  const rows: JsonObject[] = [];
  for (const variant of INTERFACE_VARIANTS) {
    for (const model of models) {
      for (const journey of GOLDEN_JOURNEYS) {
        for (let trial = 0; trial < trials; trial += 1) {
          console.error(`[agent-evals] ${variant.id} ${model.label} ${journey.id} trial ${trial + 1}/${trials}`);
          rows.push(await runTrial(journey, variant, model));
        }
      }
    }
  }
  const byVariant: JsonObject = {};
  for (const variant of INTERFACE_VARIANTS) {
    const variantRows = rows.filter((row) => row.variant === variant.id);
    byVariant[variant.id] = {
      surface: variant.surface,
      guidance: variant.guidance,
      tool_count: variant.toolNames.length,
      aggregate: aggregate(variantRows),
      by_model: Object.fromEntries(models.map((model) => [model.label, aggregate(variantRows.filter((row) => row.model === model.label))])),
    };
  }
  const bySurface: JsonObject = {};
  for (const surface of ["full", "semantic"] as const) {
    const surfaceRows = rows.filter((row) => row.surface === surface);
    bySurface[surface] = { aggregate: aggregate(surfaceRows), by_model: Object.fromEntries(models.map((model) => [model.label, aggregate(surfaceRows.filter((row) => row.model === model.label))])) };
  }
  const baseReport = agentEvalReport();
  const baseComparison = object(baseReport.tool_surface_comparison) ?? {};
  const report = {
    ...baseReport,
    generated_at: new Date().toISOString(),
    status: "complete",
    gateway_url: gatewayUrl,
    trials_per_journey: trials,
    configured_models: models,
    webmcp_agent_evals: { status: "complete", runner: "scripts/run-agent-evals.ts", models, repeated_trials_target: trials, variants: byVariant, surfaces: bySurface },
    tool_surface_comparison: { ...baseComparison, status: "complete", full: { ...(object(baseComparison.full) ?? {}), observed: byVariant.legacy_full }, semantic: { ...(object(baseComparison.semantic) ?? {}), observed: byVariant.lean_deterministic_advanced }, decision: "keep the lean deterministic surface primary; retain advanced contracts behind strict find/call dispatch and compare all four observed variants" },
    false_success_count: falseSuccessCount(rows),
    efficiency_benchmark: {
      ...(object(baseReport.efficiency_benchmark) ?? {}),
      observed: efficiencyBenchmark(rows.filter((row) => row.journey_id === "fresh-agent-tentree-url" && row.variant === "lean_deterministic_advanced")),
      observed_by_variant: Object.fromEntries(INTERFACE_VARIANTS.map((variant) => [variant.id, efficiencyBenchmark(rows.filter((row) => row.journey_id === "fresh-agent-tentree-url" && row.variant === variant.id))])),
      deepseek_context_overflow_regression: (() => {
        const deepseekRows = rows.filter((row) => row.journey_id === "fresh-agent-tentree-url" && row.variant === "lean_deterministic_advanced" && /deepseek/i.test(`${row.model ?? ""} ${row.model_id ?? ""}`));
        const overflow = deepseekRows.reduce((sum, row) => sum + (typeof row.context_overflow_count === "number" ? row.context_overflow_count : 0), 0);
        return {
          status: deepseekRows.length ? "complete" : "not_run",
          model_match: "model label or ID containing deepseek",
          trials: deepseekRows.length,
          context_overflow_count: deepseekRows.length ? overflow : null,
          pass: deepseekRows.length ? overflow === 0 : null,
          observed: deepseekRows.length ? efficiencyBenchmark(deepseekRows) : null,
        };
      })(),
    },
    trials: rows,
  };
  await writeReport(report);
  console.log(JSON.stringify({ status: "complete", output: outputPath, variants: byVariant, surfaces: bySurface }, null, 2));
}

await main();
