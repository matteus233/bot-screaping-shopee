// src/filters/productFilter.ts - Motor de filtragem de produtos
import { filterConfig } from "../config";
import { logger } from "../utils/logger";
import { DatabaseManager } from "../database/dbManager";
import type { ShopeeProduct, FilterResult, CategoryKey } from "../types/index";
import { SHOPEE_CATEGORIES } from "../types/index";

type Check = (product: ShopeeProduct) => FilterResult | Promise<FilterResult>;

export class ProductFilter {
  private readonly db: DatabaseManager;

  constructor(db: DatabaseManager) {
    this.db = db;
  }

  // ----------------------------------------
  //  API publica
  // ----------------------------------------
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
    const reasonCount = new Map<string, number>();
    rejected.forEach(({ product, result }) => {
      logger.debug(`Rejeitado [${product.itemName?.slice(0, 40)}]: ${result.reason}`);
      if (result.reason) {
        reasonCount.set(result.reason, (reasonCount.get(result.reason) ?? 0) + 1);
      }
    });

    if (reasonCount.size > 0) {
      const top = Array.from(reasonCount.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([reason, count]) => `${count}x ${reason}`)
        .join(" | ");
      logger.info(`Motivos mais comuns: ${top}`);
    }

    logger.info(`Filtro: ${valid.length}/${products.length} produtos aprovados`);
    return valid;
  }

  // ----------------------------------------
  //  Verificacoes individuais
  // ----------------------------------------

  private checkDiscount(p: ShopeeProduct): FilterResult {
    const cfg = filterConfig;
    const current = p.priceMin ?? 0;

    let discountPct = p._discountPct;
    if (discountPct === undefined) {
      const original = p.originalPrice ?? 0;
      if (original > 0 && current > 0) {
        discountPct = ((original - current) / original) * 100;
        p._discountPct = Math.round(discountPct * 10) / 10;
      }
    }

    // Se nao ha informacao de desconto, nao bloqueia o produto
    if (discountPct === undefined) {
      return { passed: true, reason: "" };
    }

    if (discountPct < cfg.minDiscountPercent) {
      return {
        passed: false,
        reason: `desconto ${discountPct.toFixed(1)}% < minimo ${cfg.minDiscountPercent}%`,
      };
    }

    return { passed: true, reason: "" };
  }

  private checkPrice(p: ShopeeProduct): FilterResult {
    const price = p.priceMin ?? 0;
    const cfg = filterConfig;

    if (price < cfg.minPriceBRL) {
      return { passed: false, reason: `preco R$${price} abaixo do minimo R$${cfg.minPriceBRL}` };
    }
    if (price > cfg.maxPriceBRL) {
      return { passed: false, reason: `preco R$${price} acima do maximo R$${cfg.maxPriceBRL}` };
    }

    return { passed: true, reason: "" };
  }

  private checkRating(p: ShopeeProduct): FilterResult {
    const rating = p.itemRating ?? 0;
    const ratingCount = p.ratingCount ?? p.rateStar ?? 0;
    const cfg = filterConfig;

    // Se a API nao trouxe rating, nao bloqueia
    if (rating <= 0) return { passed: true, reason: "" };

    if (rating < cfg.minRating) {
      return { passed: false, reason: `avaliacao ${rating} < minimo ${cfg.minRating}` };
    }

    // Se a API nao trouxe contagem, nao bloqueia
    if (ratingCount > 0 && ratingCount < cfg.minRatingCount) {
      return { passed: false, reason: `${ratingCount} avaliacoes < minimo ${cfg.minRatingCount}` };
    }

    return { passed: true, reason: "" };
  }

  private checkSales(p: ShopeeProduct): FilterResult {
    const sales = p.sales ?? 0;
    const cfg = filterConfig;

    // Se nao ha dado de vendas, nao bloqueia
    if (sales <= 0) return { passed: true, reason: "" };

    if (sales < cfg.minSales) {
      return { passed: false, reason: `${sales} vendas < minimo ${cfg.minSales}` };
    }

    return { passed: true, reason: "" };
  }

  private checkKeywords(p: ShopeeProduct): FilterResult {
    const name = (p.itemName ?? "").toLowerCase();
    const cfg = filterConfig;

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
    const allowed = new Set<string>();
    for (const entry of cfg.allowedCategories) {
      allowed.add(entry);
      if ((entry as CategoryKey) in SHOPEE_CATEGORIES) {
        const id = SHOPEE_CATEGORIES[entry as CategoryKey];
        if (id !== null && id !== undefined) allowed.add(String(id));
      }
    }

    if (!allowed.has(cat)) {
      return { passed: false, reason: `categoria ${cat} nao permitida` };
    }

    return { passed: true, reason: "" };
  }

  private async checkHistoricalPrice(p: ShopeeProduct): Promise<FilterResult> {
    const cfg = filterConfig;
    if (!cfg.historicalPriceCheck) return { passed: true, reason: "" };

    const itemId = String(p.itemId ?? "");
    const shopId = String(p.shopId ?? "");
    const current = p.priceMin ?? 0;

    if (!itemId || current <= 0) return { passed: true, reason: "" };

    // Registra preco atual no historico
    await this.db.recordPrice(itemId, shopId, current);

    const histMin = await this.db.getHistoricalMinPrice(itemId, shopId);
    if (histMin === null) return { passed: true, reason: "" }; // primeiro registro

    const threshold = histMin * cfg.maxPriceVsHistorical;
    if (current > threshold) {
      return {
        passed: false,
        reason: `preco atual R$${current.toFixed(2)} > ${(cfg.maxPriceVsHistorical * 100).toFixed(0)}% do minimo historico R$${histMin.toFixed(2)}`,
      };
    }

    p._historicalMin = histMin;
    return { passed: true, reason: "" };
  }
}
