// src/filters/productFilter.ts — Motor de filtragem de produtos
import { filterConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { DatabaseManager } from "../database/dbManager.js";
import type { ShopeeProduct, FilterResult } from "../types/index.js";

type Check = (product: ShopeeProduct) => FilterResult | Promise<FilterResult>;

export class ProductFilter {
  private readonly db: DatabaseManager;

  constructor(db: DatabaseManager) {
    this.db = db;
  }

  // ──────────────────────────────────────────────
  //  API pública
  // ──────────────────────────────────────────────

  async isValid(product: ShopeeProduct): Promise<FilterResult> {
    const checks: Check[] = [
      this.checkDiscount.bind(this),
      this.checkPrice.bind(this),
      this.checkRating.bind(this),
      this.checkSales.bind(this),
      this.checkKeywords.bind(this),
      this.checkCategory.bind(this),
      this.checkHistoricalPrice.bind(this),
    ];

    for (const check of checks) {
      const result = await check(product);
      if (!result.passed) return result;
    }

    return { passed: true, reason: "" };
  }

  async filterProducts(products: ShopeeProduct[]): Promise<ShopeeProduct[]> {
    const results = await Promise.all(
      products.map(async (p) => ({ product: p, result: await this.isValid(p) })),
    );

    const valid = results
      .filter(({ result }) => result.passed)
      .map(({ product }) => product);

    const rejected = results.filter(({ result }) => !result.passed);
    rejected.forEach(({ product, result }) => {
      logger.debug(`Rejeitado [${product.itemName?.slice(0, 40)}]: ${result.reason}`);
    });

    logger.info(`Filtro: ${valid.length}/${products.length} produtos aprovados`);
    return valid;
  }

  // ──────────────────────────────────────────────
  //  Verificações individuais
  // ──────────────────────────────────────────────

  private checkDiscount(p: ShopeeProduct): FilterResult {
    const original = p.originalPrice ?? 0;
    const current  = p.priceMin ?? 0;
    const cfg      = filterConfig;

    if (original <= 0 || current <= 0) {
      return { passed: false, reason: "preço inválido" };
    }

    const discountPct = ((original - current) / original) * 100;
    p._discountPct = Math.round(discountPct * 10) / 10;

    if (discountPct < cfg.minDiscountPercent) {
      return {
        passed: false,
        reason: `desconto ${discountPct.toFixed(1)}% < mínimo ${cfg.minDiscountPercent}%`,
      };
    }

    return { passed: true, reason: "" };
  }

  private checkPrice(p: ShopeeProduct): FilterResult {
    const price = p.priceMin ?? 0;
    const cfg   = filterConfig;

    if (price < cfg.minPriceBRL) {
      return { passed: false, reason: `preço R$${price} abaixo do mínimo R$${cfg.minPriceBRL}` };
    }
    if (price > cfg.maxPriceBRL) {
      return { passed: false, reason: `preço R$${price} acima do máximo R$${cfg.maxPriceBRL}` };
    }

    return { passed: true, reason: "" };
  }

  private checkRating(p: ShopeeProduct): FilterResult {
    const rating      = p.itemRating ?? 0;
    const ratingCount = p.ratingCount ?? p.rateStar ?? 0;
    const cfg         = filterConfig;

    if (rating < cfg.minRating) {
      return { passed: false, reason: `avaliação ${rating} < mínimo ${cfg.minRating}` };
    }
    if (ratingCount < cfg.minRatingCount) {
      return { passed: false, reason: `${ratingCount} avaliações < mínimo ${cfg.minRatingCount}` };
    }

    return { passed: true, reason: "" };
  }

  private checkSales(p: ShopeeProduct): FilterResult {
    const sales = p.sales ?? 0;
    const cfg   = filterConfig;

    if (sales < cfg.minSales) {
      return { passed: false, reason: `${sales} vendas < mínimo ${cfg.minSales}` };
    }

    return { passed: true, reason: "" };
  }

  private checkKeywords(p: ShopeeProduct): FilterResult {
    const name = (p.itemName ?? "").toLowerCase();
    const cfg  = filterConfig;

    for (const kw of cfg.keywordsBlacklist) {
      if (name.includes(kw.toLowerCase())) {
        return { passed: false, reason: `blacklist: '${kw}'` };
      }
    }

    if (
      cfg.keywordsWhitelist.length > 0 &&
      !cfg.keywordsWhitelist.some((kw) => name.includes(kw.toLowerCase()))
    ) {
      return { passed: false, reason: "nenhuma keyword da whitelist encontrada" };
    }

    return { passed: true, reason: "" };
  }

  private checkCategory(p: ShopeeProduct): FilterResult {
    const cfg = filterConfig;
    if (cfg.allowedCategories.length === 0) return { passed: true, reason: "" };

    const cat = String(p.catId ?? p.categoryId ?? "");
    if (!cfg.allowedCategories.includes(cat)) {
      return { passed: false, reason: `categoria ${cat} não permitida` };
    }

    return { passed: true, reason: "" };
  }

  private async checkHistoricalPrice(p: ShopeeProduct): Promise<FilterResult> {
    const cfg     = filterConfig;
    if (!cfg.historicalPriceCheck) return { passed: true, reason: "" };

    const itemId  = String(p.itemId ?? "");
    const shopId  = String(p.shopId ?? "");
    const current = p.priceMin ?? 0;

    if (!itemId || current <= 0) return { passed: true, reason: "" };

    // Registra preço atual no histórico
    await this.db.recordPrice(itemId, shopId, current);

    const histMin = await this.db.getHistoricalMinPrice(itemId, shopId);
    if (histMin === null) return { passed: true, reason: "" };  // primeiro registro

    const threshold = histMin * cfg.maxPriceVsHistorical;
    if (current > threshold) {
      return {
        passed: false,
        reason: `preço atual R$${current.toFixed(2)} > ${(cfg.maxPriceVsHistorical * 100).toFixed(0)}% do mínimo histórico R$${histMin.toFixed(2)}`,
      };
    }

    p._historicalMin = histMin;
    return { passed: true, reason: "" };
  }
}