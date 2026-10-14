import { describe, expect, it } from "vitest";
import { maskPhone } from "../src/channels/channels.js";
import { allowed, backoffMs } from "../src/notifications/notification-service.js";
import { formatMoney, render, TEMPLATES, TemplateError } from "../src/templates/templates.js";

const prefs = (o: Partial<{ eo: boolean; em: boolean; so: boolean }> = {}) => ({
  email: { orderUpdates: o.eo ?? true, marketing: o.em ?? false },
  sms: { orderUpdates: o.so ?? false, phone: null },
});

describe("templates", () => {
  it("formats money exactly from integer minor units", () => {
    expect(formatMoney(117_764n, "INR")).toBe("₹1,177.64");
    expect(formatMoney(5n, "INR")).toBe("₹0.05");
    expect(formatMoney(1_000n, "JPY")).toBe("JP¥1,000");
    expect(formatMoney(123_456_789_01n, "USD")).toBe("$12,34,56,789.01"); // en-IN grouping
  });

  it("every template renders for each of its channels with representative data", () => {
    const data = { orderId: "0192a1b2-0000-7000-8000-000000000201", total: { amountMinor: 100, currency: "INR" }, amount: { amountMinor: 100, currency: "INR" },
      reason: "OUT_OF_STOCK", url: "http://x/y", sku: "SKU-1", available: 1, threshold: 5 };
    for (const [key, t] of Object.entries(TEMPLATES)) {
      for (const channel of t.channels) expect(render(key, channel, data, { shopBaseUrl: "http://shop" }).text.length).toBeGreaterThan(0);
    }
  });

  it("missing data is a template error (permanent), not a crash", () => {
    expect(() => render("order.confirmed", "email", {}, { shopBaseUrl: "http://shop" })).toThrow(TemplateError);
    expect(() => render("toString", "email", {}, { shopBaseUrl: "http://shop" })).toThrow(TemplateError); // no prototype lookups
  });

  it("names are text, never markup", () => {
    const r = render("account.welcome", "email", {}, { shopBaseUrl: "http://shop", fullName: "<script>x</script>" });
    expect(r.text).toContain("<script>x</script>"); // plain-text email: shown literally, never interpreted
  });
});

describe("policy", () => {
  it("full-jitter backoff stays within [0, min(cap, base·2^(n-1))]", () => {
    expect(backoffMs(1, 30_000, 3_600_000, () => 1)).toBe(30_000);
    expect(backoffMs(4, 30_000, 3_600_000, () => 1)).toBe(240_000);
    expect(backoffMs(20, 30_000, 3_600_000, () => 1)).toBe(3_600_000);
    expect(backoffMs(3, 30_000, 3_600_000, () => 0)).toBe(0);
  });

  it("security and admin messages ignore opt-outs; order updates follow preferences", () => {
    expect(allowed("security", "email", prefs({ eo: false }))).toBe(true);
    expect(allowed("order_updates", "email", prefs({ eo: false }))).toBe(false);
    expect(allowed("order_updates", "sms", prefs())).toBe(false);
    expect(allowed("order_updates", "sms", prefs({ so: true }))).toBe(true);
    expect(allowed("marketing", "email", prefs())).toBe(false);
  });

  it("masks phone numbers for logs", () => {
    expect(maskPhone("+919800000001")).toBe("*********0001");
  });
});
