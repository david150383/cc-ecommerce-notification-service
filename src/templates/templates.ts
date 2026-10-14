/**
 * Message templates. Plain text on purpose: no HTML means no HTML injection from data such as a
 * customer's name, and every mail client shows it. Each template declares its category, which
 * decides how preferences apply (see `preferenceFor`).
 */
export type Category =
  /** Account security (verification, password reset): always sent, opt-outs do not apply. */
  | "security"
  /** Account lifecycle (welcome). */
  | "account"
  | "order_updates"
  | "marketing"
  /** Operator alerts to fixed addresses. */
  | "admin";

export type Channel = "email" | "sms";

export interface Rendered {
  subject: string;
  text: string;
}

export interface RenderContext {
  shopBaseUrl: string;
  /** Contact name from the directory (or the request), never trusted as markup. */
  fullName?: string | null;
}

type Data = Record<string, unknown>;

interface Template {
  category: Category;
  channels: Channel[];
  email?: (data: Data, ctx: RenderContext) => Rendered;
  /** SMS: short, no links to sensitive pages. */
  sms?: (data: Data, ctx: RenderContext) => string;
}

export class TemplateError extends Error {}

function str(data: Data, key: string): string {
  const v = data[key];
  if (typeof v !== "string" || v.length === 0) throw new TemplateError(`template data is missing "${key}"`);
  return v;
}

function money(data: Data, key: string): string {
  const m = data[key] as { amountMinor?: unknown; currency?: unknown } | undefined;
  if (!m || typeof m.currency !== "string" || (typeof m.amountMinor !== "number" && typeof m.amountMinor !== "string")) {
    throw new TemplateError(`template data is missing "${key}"`);
  }
  return formatMoney(BigInt(m.amountMinor), m.currency);
}

/** Integer minor units → "₹1,177.64" without floating-point arithmetic on the amount. */
export function formatMoney(amountMinor: bigint, currency: string): string {
  const fmt = new Intl.NumberFormat("en-IN", { style: "currency", currency });
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  const scale = 10n ** BigInt(digits);
  const negative = amountMinor < 0n;
  const abs = negative ? -amountMinor : amountMinor;
  const major = abs / scale;
  const minor = abs % scale;
  // Format the integer part via Intl (grouping, symbol), then splice in the exact fraction.
  const parts = fmt.formatToParts(Number(major));
  const out = parts
    .map((p) => (p.type === "fraction" ? minor.toString().padStart(digits, "0") : p.type === "decimal" && digits === 0 ? "" : p.value))
    .join("");
  return negative ? `-${out}` : out;
}

const greet = (ctx: RenderContext) => `Hi ${ctx.fullName?.trim() || "there"},`;
const shortId = (id: string) => id.slice(-8).toUpperCase();

const CANCEL_REASONS: Record<string, string> = {
  OUT_OF_STOCK: "some items went out of stock",
  PAYMENT_FAILED: "the payment did not go through",
  PAYMENT_TIMEOUT: "the payment was not completed in time",
  CUSTOMER_REQUESTED: "you asked us to cancel it",
  ADMIN: "our team cancelled it",
  SYSTEM: "of a problem on our side",
};

export const TEMPLATES: Record<string, Template> = {
  "auth.verify-email": {
    category: "security",
    channels: ["email"],
    email: (d, ctx) => ({
      subject: "Verify your email address",
      text: `${greet(ctx)}\n\nUse this link to verify your email address:\n${str(d, "url")}\n\nIf you did not create an account, ignore this email.`,
    }),
  },
  "auth.password-reset": {
    category: "security",
    channels: ["email"],
    email: (d, ctx) => ({
      subject: "Reset your password",
      text: `${greet(ctx)}\n\nUse this link to reset your password:\n${str(d, "url")}\n\nThe link works once and expires soon. If you did not ask for this, ignore this email: your password has not changed.`,
    }),
  },
  "account.welcome": {
    category: "account",
    channels: ["email"],
    email: (_d, ctx) => ({
      subject: "Welcome to the shop",
      text: `${greet(ctx)}\n\nThanks for signing up. Start browsing: ${ctx.shopBaseUrl}\n`,
    }),
  },
  "order.confirmed": {
    category: "order_updates",
    channels: ["email", "sms"],
    email: (d, ctx) => ({
      subject: `Order ${shortId(str(d, "orderId"))} confirmed`,
      text: `${greet(ctx)}\n\nYour order ${shortId(str(d, "orderId"))} is confirmed. Total paid: ${money(d, "total")}.\n\nTrack it here: ${ctx.shopBaseUrl}/orders/${str(d, "orderId")}\n`,
    }),
    sms: (d) => `Order ${shortId(str(d, "orderId"))} confirmed. Total ${money(d, "total")}.`,
  },
  "order.cancelled": {
    category: "order_updates",
    channels: ["email", "sms"],
    email: (d, ctx) => ({
      subject: `Order ${shortId(str(d, "orderId"))} cancelled`,
      text: `${greet(ctx)}\n\nYour order ${shortId(str(d, "orderId"))} was cancelled because ${CANCEL_REASONS[str(d, "reason")] ?? "of a problem"}.\nIf you were charged, the money is refunded automatically; you will get a separate email when it is.\n`,
    }),
    sms: (d) => `Order ${shortId(str(d, "orderId"))} was cancelled.`,
  },
  "order.shipped": {
    category: "order_updates",
    channels: ["email", "sms"],
    email: (d, ctx) => ({
      subject: `Order ${shortId(str(d, "orderId"))} shipped`,
      text: `${greet(ctx)}\n\nGood news: order ${shortId(str(d, "orderId"))} is on its way.\n\n${ctx.shopBaseUrl}/orders/${str(d, "orderId")}\n`,
    }),
    sms: (d) => `Order ${shortId(str(d, "orderId"))} has shipped.`,
  },
  "order.delivered": {
    category: "order_updates",
    channels: ["email", "sms"],
    email: (d, ctx) => ({
      subject: `Order ${shortId(str(d, "orderId"))} delivered`,
      text: `${greet(ctx)}\n\nOrder ${shortId(str(d, "orderId"))} was delivered. Enjoy!\n`,
    }),
    sms: (d) => `Order ${shortId(str(d, "orderId"))} was delivered.`,
  },
  "payment.refunded": {
    category: "order_updates",
    channels: ["email"],
    email: (d, ctx) => ({
      subject: `Refund for order ${shortId(str(d, "orderId"))}`,
      text: `${greet(ctx)}\n\nWe refunded ${money(d, "amount")} for order ${shortId(str(d, "orderId"))}. Depending on your bank it can take a few days to show up.\n`,
    }),
  },
  "admin.low-stock": {
    category: "admin",
    channels: ["email"],
    email: (d) => ({
      subject: `Low stock: ${str(d, "sku")}`,
      text: `SKU ${str(d, "sku")} is down to ${String(d.available)} available (threshold ${String(d.threshold)}).\n`,
    }),
  },
};

export function getTemplate(key: string): Template | undefined {
  return Object.hasOwn(TEMPLATES, key) ? TEMPLATES[key] : undefined;
}

export function render(key: string, channel: Channel, data: Data, ctx: RenderContext): Rendered {
  const t = getTemplate(key);
  if (!t) throw new TemplateError(`unknown template ${key}`);
  if (channel === "email" && t.email) return t.email(data, ctx);
  if (channel === "sms" && t.sms) return { subject: "", text: t.sms(data, ctx) };
  throw new TemplateError(`template ${key} has no ${channel} version`);
}
