// src/utils/formatter.ts — Formatador de mensagens
import type { ShopeeProduct } from "../types/index";
import { SHOPEE_CATEGORIES } from "../types/index";

function stars(rating: number): string {
  const full  = Math.floor(rating);
  const empty = 5 - full;
  return "⭐".repeat(full) + "☆".repeat(empty);
}

function discountBadge(pct: number): string {
  if (pct >= 70) return "🔥🔥🔥";
  if (pct >= 50) return "🔥🔥";
  if (pct >= 30) return "🔥";
  return "🏷️";
}

function brl(value: number): string {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function categoryTag(product: ShopeeProduct): string | null {
  const catId = String(product.catId ?? product.categoryId ?? "");
  if (!catId) return null;

  const map: Array<[keyof typeof SHOPEE_CATEGORIES, string]> = [
    ["beleza", "BELEZA"],
    ["moda_feminina", "MODA"],
    ["casa_decoracao", "CASA"],
  ];

  for (const [key, label] of map) {
    const id = SHOPEE_CATEGORIES[key];
    if (id !== null && String(id) === catId) {
      return `[${label}]`;
    }
  }

  return null;
}

// ──────────────────────────────────────────────
//  Telegram (HTML)
// ──────────────────────────────────────────────
export function formatTelegram(product: ShopeeProduct, affiliateUrl?: string): string {
  const name     = product.itemName ?? "Produto";
  const price    = product.priceMin ?? 0;
  const original = product.originalPrice ?? 0;
  const discount = product._discountPct ?? 0;
  const rating   = product.itemRating ?? 0;
  const sales    = product.sales ?? 0;
  const histMin  = product._historicalMin;
  const url      = affiliateUrl ?? product.offerLink ?? product.itemUrl ?? "";
  const badge    = discountBadge(discount);

  const tag = categoryTag(product);
  const title = tag ? `${tag} ${escapeHtml(name)}` : escapeHtml(name);
  const histTag = product._isHistoricalLow ? " 🧊 PRECO HISTORICO" : "";

  const lines: string[] = [
    `${badge} <b>${title}${histTag}</b>`,
    "",
    `💰 <b>${brl(price)}</b>`,
  ];

  if (original > 0 && original !== price) {
    lines.push(`<s>${brl(original)}</s> → <b>-${discount.toFixed(0)}% OFF</b>`);
  }

  if (histMin && histMin < price * 0.98) {
    lines.push(`📉 Mínimo histórico: ${brl(histMin)}`);
  }

  lines.push(
    "",
    `${stars(rating)} ${rating.toFixed(1)}/5 · 🛒 ${sales.toLocaleString("pt-BR")} vendidos`,
    "",
    `🔗 <a href="${url}">Ver na Shopee</a>`,
  );

  return lines.join("\n");
}

// ──────────────────────────────────────────────
//  WhatsApp (texto plano)
// ──────────────────────────────────────────────
export function formatWhatsApp(product: ShopeeProduct, affiliateUrl?: string): string {
  const name     = product.itemName ?? "Produto";
  const price    = product.priceMin ?? 0;
  const original = product.originalPrice ?? 0;
  const discount = product._discountPct ?? 0;
  const rating   = product.itemRating ?? 0;
  const sales    = product.sales ?? 0;
  const histMin  = product._historicalMin;
  const url      = affiliateUrl ?? product.offerLink ?? product.itemUrl ?? "";
  const badge    = discountBadge(discount);

  const tag = categoryTag(product);
  const title = tag ? `${tag} ${name}` : name;
  const histTag = product._isHistoricalLow ? " 🧊 PRECO HISTORICO" : "";

  const lines: string[] = [
    `${badge} *${title}${histTag}*`,
    "",
    `💰 *${brl(price)}*`,
  ];

  if (original > 0 && original !== price) {
    lines.push(`De ${brl(original)} — *-${discount.toFixed(0)}% OFF*`);
  }

  if (histMin && histMin < price * 0.98) {
    lines.push(`📉 Mínimo histórico: ${brl(histMin)}`);
  }

  lines.push(
    "",
    `⭐ ${rating.toFixed(1)}/5 · ${sales.toLocaleString("pt-BR")} vendidos`,
    "",
    `🔗 ${url}`,
  );

  return lines.join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
