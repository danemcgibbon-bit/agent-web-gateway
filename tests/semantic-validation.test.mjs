import assert from "node:assert/strict";
import test from "node:test";

const { validateConnectorExecution } = await import("../lib/semantic-validation.ts");

const execution = (sourceUrl, data, mode = "http") => ({ mode, sourceUrl, data });

test("Booking junk cannot cross the semantic success boundary", () => {
  assert.throws(
    () => validateConnectorExecution(
      "booking",
      "search_hotels",
      { destination: "Brighton", check_in: "2026-09-18", check_out: "2026-09-20" },
      execution("https://www.booking.com/searchresults.html?ss=Brighton", {
        destination: "Brighton",
        check_in: "2026-09-18",
        check_out: "2026-09-20",
        results: [{ hotel_id: "index.en-gb.html", name: "Hotels", url: "https://www.booking.com/" }],
      }),
    ),
    (error) => error.code === "UPSTREAM_CHANGED" && /no valid hotel results/i.test(error.message),
  );
});

test("valid Booking results are retained and invalid rows are removed", () => {
  const result = validateConnectorExecution(
    "booking",
    "search_hotels",
    { destination: "Brighton", check_in: "2026-09-18", check_out: "2026-09-20" },
    execution("https://www.booking.com/searchresults.html?ss=Brighton", {
      destination: "Brighton",
      check_in: "2026-09-18",
      check_out: "2026-09-20",
      results: [
        { hotel_id: "index.en-gb.html", name: "Hotels", url: "https://www.booking.com/" },
        {
          hotel_id: "gb/the-grand-brighton.html",
          provider_hotel_id: "12345",
          name: "The Grand Brighton",
          url: "https://www.booking.com/hotel/gb/the-grand-brighton.html",
          location: "Brighton",
          rating: 8.4,
          review_count: 1200,
          price: { amount: 250, currency: "GBP", basis: "total_stay" },
        },
      ],
    }),
  );

  assert.equal(result.data.results.length, 1);
  assert.equal(result.data.results[0].hotel_id, "gb/the-grand-brighton.html");
});

test("provider-specific validators reject generic Eventbrite output", () => {
  assert.throws(
    () => validateConnectorExecution(
      "eventbrite",
      "search_events",
      { location: "London" },
      execution("https://www.eventbrite.co.uk/d/united-kingdom--london/caribbean/", {
        location: "London",
        results: [{ event_id: "events", title: "Events", url: "https://www.eventbrite.co.uk/" }],
      }),
    ),
    (error) => error.code === "UPSTREAM_CHANGED",
  );
});

test("IKEA product and unknown availability responses remain semantic", () => {
  const product = validateConnectorExecution(
    "ikea",
    "get_product",
    { product_id: "00324518" },
    execution("https://sik.search.blue.cdtapps.com/gb/en/search-result-page?q=00324518", {
      product: {
        product_id: "00324518",
        name: "KALLAX shelving unit",
        price: { amount: 49, currency: "GBP" },
        url: "https://www.ikea.com/gb/en/p/kallax-shelving-unit-white-00324518/",
      },
    }),
  );
  assert.equal(product.data.product.product_id, "00324518");

  const availability = validateConnectorExecution(
    "ikea",
    "check_availability",
    { product_id: "00324518", postcode: "SW1A 1AA" },
    execution("https://www.ikea.com/gb/en/p/kallax-shelving-unit-white-00324518/", {
      product_id: "00324518",
      postcode: "SW1A 1AA",
      delivery: { status: "unknown", available: null },
      stores: [],
    }, "public_http"),
  );
  assert.equal(availability.data.delivery.status, "unknown");
});

test("Amazon and eBay generic shells cannot cross the semantic boundary", () => {
  assert.throws(
    () => validateConnectorExecution(
      "amazon",
      "search_products",
      { query: "headphones" },
      execution("https://www.amazon.co.uk/s?k=headphones", {
        query: "headphones",
        results: [{ product_id: "homepage", asin: "homepage", name: "Amazon", url: "https://www.amazon.co.uk/" }],
      }, "public_http"),
    ),
    (error) => error.code === "UPSTREAM_CHANGED",
  );
  assert.throws(
    () => validateConnectorExecution(
      "ebay",
      "search_items",
      { query: "Nintendo Switch" },
      execution("https://www.ebay.co.uk/sch/i.html?_nkw=Nintendo", {
        query: "Nintendo Switch",
        results: [{ item_id: "123", title: "Items", url: "https://www.ebay.co.uk/" }],
      }, "official_api"),
    ),
    (error) => error.code === "NO_VALID_RESULTS",
  );
});
