// src/api/cuponomiaClient.ts - Coleta cupons da Shopee na Cuponomia
import axios from "axios";
import { config } from "../config";
import { logger } from "../utils/logger";
import type { ShopeeCoupon } from "../types/index";

function decodeHtml(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function stripTags(text: string): string {
  return decodeHtml(text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
}

function decodeCouponPath(base64Path: string): string | null {
  try {
    const decoded = Buffer.from(base64Path, "base64").toString("utf-8");
    if (!decoded) return null;
    if (/^https?:\/\//i.test(decoded)) return decoded;
    if (decoded.startsWith("/")) return `https://www.cuponomia.com.br${decoded}`;
    return `https://www.cuponomia.com.br/${decoded}`;
  } catch {
    return null;
  }
}

export class CuponomiaClient {
  async fetchShopeeCoupons(limit = 20): Promise<ShopeeCoupon[]> {
    try {
      const response = await axios.get(config.coupons.sourceUrl, {
        timeout: 20_000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          Accept: "text/html,application/xhtml+xml",
        },
      });

      const html = String(response.data ?? "");
      if (!html) return [];

      const blocks = html.match(/<li[^>]*data-test-id="coupon-list-item"[\s\S]*?<\/li>/gi) ?? [];
      const parsed: ShopeeCoupon[] = [];

      for (const block of blocks) {
        const id = block.match(/data-id="([^"]+)"/i)?.[1] ?? "";
        const titleRaw = block.match(/<h3[^>]*class="js-itemTitle"[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? "";
        const descRaw = block.match(/<div[^>]*class="item-desc"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "";
        const discountRaw = block.match(/<span[^>]*class="smallTitle-content[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "";
        const codeRaw = block.match(/<span[^>]*class="item-code-link[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "";
        const couponPathB64 = block.match(/data-coupon-url="([^"]+)"/i)?.[1] ?? "";

        const title = stripTags(titleRaw);
        const description = stripTags(descRaw);
        const discountText = stripTags(discountRaw);
        const couponCode = stripTags(codeRaw);
        const couponUrl = decodeCouponPath(couponPathB64) ?? config.coupons.sourceUrl;
        const couponId = id || couponCode || title;

        if (!couponId || !title) continue;

        parsed.push({
          couponId,
          title,
          description,
          discountText,
          couponCode: couponCode || undefined,
          couponUrl,
          source: "cuponomia",
        });
      }

      const seen = new Set<string>();
      const unique = parsed.filter((c) => {
        const key = `${(c.couponCode ?? "").toLowerCase()}|${c.title.toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      return unique.slice(0, Math.max(1, limit));
    } catch (err) {
      logger.warn(`[Cuponomia] Falha ao buscar cupons: ${err}`);
      return [];
    }
  }
}
