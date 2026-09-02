import {
  AGENT_QUICKSTART,
  BUILD_ID,
  GATEWAY_VERSION,
  TOOL_DEFINITIONS,
  WEBMCP_CONTRACT_VERSION,
} from "./gateway-contract";

/**
 * The single machine-facing operating manual. The page embeds this exact
 * object and /agent.json serializes it; keep it compact and task-oriented.
 */
export const AGENT_MANUAL = {
  manual_version: "1",
  gateway_version: GATEWAY_VERSION,
  build_id: BUILD_ID,
  webmcp_contract_version: WEBMCP_CONTRACT_VERSION,
  name: "Agent Web Gateway",
  purpose: "Use structured tools to perform read-only tasks against compatible public websites.",
  quickstart: {
    default_tool: AGENT_QUICKSTART.default_tool,
    instruction: "For a normal task, call gateway_task with the user's goal largely as written.",
    example: {
      tool: AGENT_QUICKSTART.default_tool,
      input: { goal: "Find the cheapest green men's sweater on https://www.tentree.com/" },
    },
  },
  rules: [
    "If the user names a website, preserve its URL in goal or pass it as the target site.",
    "The gateway handles platform detection, acquisition, filtering, ranking, and verification internally.",
    "If agent_action is answer or answer_ready is true, stop using tools and answer the user.",
    "If agent_action is follow_next_action, execute next_action exactly.",
    "If agent_action is report_partial, explain the safe limitation and stop unless a prescribed next_action is provided.",
    "Use detail tools only when the user asks for additional information about a returned item.",
    "Do not inspect the manifest or capabilities during a normal clear task.",
    "Do not browse the source website or manually paginate because it is not listed as a tested example.",
    "Use gateway_find_tool once, then gateway_call_tool, only for uncommon functionality.",
  ],
  capabilities: {
    commerce: {
      search_tool: "commerce_search_products",
      detail_tool: "commerce_get_product",
      description: "Search and retrieve products from public commerce sources and targeted compatible storefronts.",
    },
    jobs: {
      search_tool: "jobs_search",
      detail_tool: "jobs_get_listing",
      description: "Search and retrieve public job listings.",
    },
    rentals: {
      search_tool: "rentals_search_properties",
      detail_tool: "rentals_get_listing",
      description: "Search and retrieve public rental listings.",
    },
  },
  result_handling: {
    answer: "Answer immediately; do not repeat diagnostics or browse independently.",
    follow_next_action: "Run the returned tool and arguments exactly.",
    clarify: "Ask the returned clarification before continuing.",
    report_partial: "Report the limitation without restarting the same search independently.",
  },
  advanced: {
    discovery: "gateway_find_tool",
    execution: "gateway_call_tool",
    instruction: "Use the exact registered operation and validated arguments only when the normal tools do not cover the request.",
  },
  safety: "Read-only public-web gateway. Do not assume transaction support.",
} as const;

export const AGENT_MANUAL_TOOL_NAMES = [
  AGENT_MANUAL.quickstart.default_tool,
  ...Object.values(AGENT_MANUAL.capabilities).flatMap((capability) => [capability.search_tool, capability.detail_tool]),
  AGENT_MANUAL.advanced.discovery,
  AGENT_MANUAL.advanced.execution,
] as string[];

export function validateAgentManualReferences(toolNames = TOOL_DEFINITIONS.map((tool) => tool.name)): {
  valid: boolean;
  references: string[];
  missing: string[];
} {
  const references = [...new Set(AGENT_MANUAL_TOOL_NAMES)];
  const available = new Set(toolNames);
  const missing = references.filter((name) => !available.has(name));
  return { valid: missing.length === 0, references, missing };
}
