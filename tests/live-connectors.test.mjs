import assert from "node:assert/strict";
import test from "node:test";

const enabled = process.env.LIVE_CONNECTOR_TESTS === "1";
const appUrl = new URL("../dist/server/index.js", import.meta.url);
appUrl.searchParams.set("live", `${process.pid}-${Date.now()}`);
const { default: app } = enabled ? await import(appUrl.href) : { default: null };
const env = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function call(provider, tool, argumentsValue) {
  const response = await app.fetch(new Request("http://localhost/api/execute", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ provider, tool, arguments: argumentsValue }),
  }), env, ctx);
  return { httpStatus: response.status, body: await response.json() };
}

function assertHonestOrReturn(body) {
  if (body.status === "error") {
    assert.ok([
      "UPSTREAM_BLOCKED",
      "UPSTREAM_CHANGED",
      "UPSTREAM_TIMEOUT",
      "RATE_LIMITED",
      "NO_VALID_RESULTS",
      "PROVIDER_UNSUPPORTED",
    "NOT_FOUND",
      "PROVIDER_RESTRICTED",
    ].includes(body.error?.code), `unexpected live connector error: ${JSON.stringify(body)}`);
    return null;
  }
  assert.equal(body.status, "success");
  assert.equal(typeof body.execution?.http?.attempted, "boolean");
  assert.equal(typeof body.execution?.fallback?.eligible, "boolean");
  assert.equal(typeof body.execution?.semantic_validation?.outcome, "string");
  assert.match(body.source?.url ?? "", /^https:\/\//);
  assert.match(body.source?.retrieved_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(body.source?.trust, "external_untrusted");
  return body;
}

test("live IKEA search and detail chain is real or honestly unavailable", { skip: !enabled }, async () => {
  const search = assertHonestOrReturn((await call("ikea", "search_products", { query: "KALLAX", max_results: 5, currency: "GBP", locale: "en-GB" })).body);
  if (!search) return;
  assert.ok(search.data.results.length > 0, "IKEA returned a success envelope with no KALLAX results");
  assert.ok(search.data.results.every((item) => /^\d{8}$/.test(item.product_id) && typeof item.price?.amount === "number" && item.price.currency === "GBP" && item.url.includes("ikea.com")));
  const detail = assertHonestOrReturn((await call("ikea", "get_product", { product_id: search.data.results[0].product_id, currency: "GBP", locale: "en-GB" })).body);
  if (detail) assert.equal(detail.data.product.product_id, search.data.results[0].product_id);
});

test("live Eventbrite search and detail chain is real or honestly unavailable", { skip: !enabled }, async () => {
  const search = assertHonestOrReturn((await call("eventbrite", "search_events", { query: "Caribbean", location: "London", max_results: 5, currency: "GBP", locale: "en-GB", timezone: "Europe/London" })).body);
  if (!search) return;
  assert.ok(search.data.results.length > 0, "Eventbrite returned a success envelope with no Caribbean results");
  assert.ok(search.data.results.every((item) => item.event_id && item.url.includes("eventbrite.co.uk")));
  const detail = assertHonestOrReturn((await call("eventbrite", "get_event", { event_id: search.data.results[0].event_id, locale: "en-GB", timezone: "Europe/London" })).body);
  if (detail) assert.equal(detail.data.event.event_id, search.data.results[0].event_id);
});

test("live Booking search and room chain is real or honestly unavailable", { skip: !enabled }, async () => {
  const search = assertHonestOrReturn((await call("booking", "search_hotels", { destination: "Brighton", check_in: "2026-09-18", check_out: "2026-09-20", adults: 2, rooms: 1, max_results: 5, currency: "GBP", locale: "en-GB", timezone: "Europe/London" })).body);
  if (!search) return;
  assert.ok(search.data.results.length > 0, "Booking.com returned a success envelope with no Brighton results");
  assert.ok(search.data.results.every((item) => item.hotel_id && item.url.includes("booking.com")));
  const hotelId = search.data.results[0].hotel_id;
  const detail = assertHonestOrReturn((await call("booking", "get_hotel", { hotel_id: hotelId, currency: "GBP", locale: "en-GB", timezone: "Europe/London" })).body);
  if (detail) assert.equal(detail.data.hotel.hotel_id, hotelId);
  const rooms = assertHonestOrReturn((await call("booking", "get_room_options", { hotel_id: hotelId, check_in: "2026-09-18", check_out: "2026-09-20", adults: 2, rooms: 1, currency: "GBP", locale: "en-GB", timezone: "Europe/London" })).body);
  if (rooms) assert.ok(Array.isArray(rooms.data.rooms));
});

test("live Amazon search and detail chain is real or honestly unavailable", { skip: !enabled }, async () => {
  const search = assertHonestOrReturn((await call("amazon", "search_products", { query: "wireless headphones", max_results: 5, currency: "GBP", locale: "en-GB" })).body);
  if (!search) return;
  assert.ok(search.data.results.length > 0, "Amazon returned a success envelope with no product results");
  assert.ok(search.data.results.every((item) => /^[A-Z0-9]{10}$/.test(item.asin) && item.url.includes("amazon.co.uk")));
  const detail = assertHonestOrReturn((await call("amazon", "get_product", { product_id: search.data.results[0].asin, currency: "GBP", locale: "en-GB" })).body);
  if (detail) assert.equal(detail.data.product.asin, search.data.results[0].asin);
});

test("live Argos search and detail chain is real or honestly unavailable", { skip: !enabled }, async () => {
  const search = assertHonestOrReturn((await call("argos", "search_products", { query: "floor lamp", max_results: 5, currency: "GBP", locale: "en-GB" })).body);
  if (!search) return;
  assert.ok(search.data.results.length > 0, "Argos returned a success envelope with no product results");
  assert.ok(search.data.results.every((item) => /^\d{4,14}$/.test(item.product_id) && item.url.includes("argos.co.uk/product/")));
  const detail = assertHonestOrReturn((await call("argos", "get_product", { product_id: search.data.results[0].product_id, currency: "GBP", locale: "en-GB" })).body);
  if (detail) assert.equal(detail.data.product.product_id, search.data.results[0].product_id);
});

test("live John Lewis search and detail chain is real or honestly unavailable", { skip: !enabled }, async () => {
  const search = assertHonestOrReturn((await call("johnlewis", "search_products", { query: "floor lamp", max_results: 5, currency: "GBP", locale: "en-GB" })).body);
  if (!search) return;
  assert.ok(search.data.results.length > 0, "John Lewis returned a success envelope with no product results");
  assert.ok(search.data.results.every((item) => /^\d{5,12}$/.test(item.product_id)
    && item.url.includes("johnlewis.com")
    && (item.price === null || (item.price.currency === "GBP" && typeof item.price.amount === "number"))));
  const detail = assertHonestOrReturn((await call("johnlewis", "get_product", { product_id: search.data.results[0].product_id, currency: "GBP", locale: "en-GB" })).body);
  if (detail) assert.equal(detail.data.product.product_id, search.data.results[0].product_id);
});

test("live eBay search and detail chain is real or honestly unavailable", { skip: !enabled }, async () => {
  const search = assertHonestOrReturn((await call("ebay", "search_items", { query: "Nintendo Switch", max_results: 5, currency: "GBP", locale: "en-GB" })).body);
  if (!search) return;
  assert.ok(search.data.results.length > 0, "eBay returned a success envelope with no item results");
  assert.ok(search.data.results.every((item) => item.item_id && item.url.includes("ebay.co.uk")));
  const detail = assertHonestOrReturn((await call("ebay", "get_item", { item_id: search.data.results[0].item_id, currency: "GBP", locale: "en-GB" })).body);
  if (detail) assert.equal(detail.data.item.item_id, search.data.results[0].item_id);
});

test("live rail search is real or honestly unavailable", { skip: !enabled }, async () => {
  const search = assertHonestOrReturn((await call("rail", "search_journeys", { origin: "London", destination: "Brighton", departure_date: "2026-09-18", adults: 2, max_results: 5, locale: "en-GB", timezone: "Europe/London" })).body);
  if (!search) return;
  assert.ok(search.data.results.length > 0, "Rail returned a success envelope with no journey results");
  assert.ok(search.data.results.every((item) => item.service_id && item.origin && item.destination));
  const detail = assertHonestOrReturn((await call("rail", "get_service", { service_id: search.data.results[0].service_id, departure_date: "2026-09-18", locale: "en-GB", timezone: "Europe/London" })).body);
  if (detail) assert.equal(detail.data.service.service_id, search.data.results[0].service_id);
});
