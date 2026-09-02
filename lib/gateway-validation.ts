import type { JsonObject, ToolDefinition } from "./gateway-contract";
import { GatewayError } from "./gateway-runtime";

export function validateToolInput(tool: ToolDefinition, value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayError("INPUT_INVALID", "arguments must be a JSON object.");
  }
  const input = normalizeCommonValues({ ...(value as JsonObject) });
  if (tool.name === "rentals_search_properties" && input.sort_by === "newest") input.sort_by = "freshest";
  const schema = tool.inputSchema;
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties as JsonObject : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];

  for (const name of required) {
    if (!(name in input)) throw new GatewayError("INPUT_INVALID", `arguments.${name} is required.`);
  }
  if (schema.additionalProperties === false) {
    for (const name of Object.keys(input)) {
      // Rental intent aliases are accepted by the gateway task and direct
      // callers without changing the frozen WebMCP tool schema. This keeps
      // older ChatGPT/OpenClaw registrations byte-compatible while allowing
      // the canonical rental evaluator to receive explicit couples and
      // availability requirements.
      const rentalAlias = tool.name === "rentals_search_properties" && ["couples_required", "available_now"].includes(name);
      if (!(name in properties) && !rentalAlias) throw new GatewayError("INPUT_INVALID", `arguments.${name} is not accepted by this tool.`);
    }
  }

  for (const [name, property] of Object.entries(properties)) {
    if (!(name in input)) continue;
    validateValue(`arguments.${name}`, input[name], property as JsonObject);
  }
  if (tool.name === "rentals_search_properties") {
    for (const name of ["couples_required", "available_now"]) {
      if (name in input && typeof input[name] !== "boolean") throw new GatewayError("INPUT_INVALID", `arguments.${name} must be a boolean.`);
    }
  }
  return input;
}

/** Normalize low-risk human variants before strict enum validation. */
function normalizeCommonValues(input: JsonObject): JsonObject {
  const normalized = { ...input };
  if (normalized.color === undefined && typeof normalized.colour === "string") normalized.color = normalized.colour;
  if (normalized.site === undefined && typeof normalized.url === "string") normalized.site = normalized.url;
  if (normalized.sort_by === undefined && typeof normalized.sort === "string") normalized.sort_by = normalized.sort;
  delete normalized.colour;
  delete normalized.url;
  delete normalized.sort;
  if (typeof normalized.audience === "string") {
    const value = normalized.audience.toLowerCase().replace(/[’']/g, "").replace(/[\s-]+/g, "_");
    const aliases: Record<string, string> = {
      male: "men", man: "men", mens: "men", menswear: "men",
      female: "women", woman: "women", womens: "women", womenswear: "women",
      child: "kids", children: "kids", boys: "kids", girls: "kids", childrens: "kids",
      all: "unisex", gender_neutral: "unisex",
    };
    normalized.audience = aliases[value] ?? value;
  }
  if (typeof normalized.size === "string") {
    const value = normalized.size.trim().toLowerCase().replace(/[\s-]+/g, "_");
    const aliases: Record<string, string> = {
      small: "S", medium: "M", large: "L", extra_large: "XL", x_large: "XL", extra_small: "XS", x_small: "XS",
    };
    normalized.size = aliases[value] ?? normalized.size.trim().toUpperCase();
  }
  if (typeof normalized.furnishing === "string") {
    const value = normalized.furnishing.trim().toLowerCase().replace(/[\s-]+/g, "_");
    normalized.furnishing = value === "part_furnished" ? "part_furnished" : value;
  }
  if (typeof normalized.condition === "string") {
    const value = normalized.condition.trim().toLowerCase().replace(/[\s-]+/g, "_");
    normalized.condition = value === "new_condition" ? "new" : value;
  }
  return normalized;
}

function validateValue(path: string, value: unknown, schema: JsonObject): void {
  const type = schema.type;
  if (type === "string") {
    if (typeof value !== "string") throw new GatewayError("INPUT_INVALID", `${path} must be a string.`);
    const minLength = typeof schema.minLength === "number" ? schema.minLength : 0;
    const maxLength = typeof schema.maxLength === "number" ? schema.maxLength : Number.POSITIVE_INFINITY;
    if (value.length < minLength) throw new GatewayError("INPUT_INVALID", `${path} must not be empty.`);
    if (value.length > maxLength) throw new GatewayError("INPUT_INVALID", `${path} is too long.`);
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      throw new GatewayError("INPUT_INVALID", `${path} must be one of the accepted enum values.`);
    }
    if (schema.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new GatewayError("INPUT_INVALID", `${path} must use YYYY-MM-DD.`);
    }
    return;
  }
  if (type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) throw new GatewayError("INPUT_INVALID", `${path} must be an integer.`);
    validateNumber(path, value, schema);
    return;
  }
  if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new GatewayError("INPUT_INVALID", `${path} must be a number.`);
    validateNumber(path, value, schema);
    return;
  }
  if (type === "boolean" && typeof value !== "boolean") {
    throw new GatewayError("INPUT_INVALID", `${path} must be a boolean.`);
  }
  if (type === "array") {
    if (!Array.isArray(value)) throw new GatewayError("INPUT_INVALID", `${path} must be an array.`);
    const minItems = typeof schema.minItems === "number" ? schema.minItems : 0;
    const maxItems = typeof schema.maxItems === "number" ? schema.maxItems : Number.POSITIVE_INFINITY;
    if (value.length < minItems) throw new GatewayError("INPUT_INVALID", `${path} must contain at least ${minItems} item${minItems === 1 ? "" : "s"}.`);
    if (value.length > maxItems) throw new GatewayError("INPUT_INVALID", `${path} contains too many items.`);
    if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
      value.forEach((item, index) => validateValue(`${path}[${index}]`, item, schema.items as JsonObject));
    }
    return;
  }
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayError("INPUT_INVALID", `${path} must be an object.`);
  }
}

function validateNumber(path: string, value: number, schema: JsonObject): void {
  if (typeof schema.minimum === "number" && value < schema.minimum) throw new GatewayError("INPUT_INVALID", `${path} is below the minimum.`);
  if (typeof schema.maximum === "number" && value > schema.maximum) throw new GatewayError("INPUT_INVALID", `${path} exceeds the maximum.`);
}

export function validateDateRange(input: JsonObject, startKey: string, endKey: string): void {
  const start = input[startKey];
  const end = input[endKey];
  if (typeof start !== "string" || typeof end !== "string") return;
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    throw new GatewayError("INPUT_INVALID", `${endKey} must be after ${startKey}.`);
  }
}

export function validateUkPostcode(value: string): void {
  if (!/^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(value.trim())) {
    throw new GatewayError("INPUT_INVALID", "postcode must be a syntactically valid UK postcode.");
  }
}
