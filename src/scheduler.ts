// src/scheduler.ts - Orquestrador principal (node-cron)
import cron from "node-cron";
import { config, filterConfig } from "./config";
import { ShopeeClient } from "./api/shopeeClient";
import { ProductFilter } from "./filters/productFilter";
import { DatabaseManager } from "./database/dbManager";
import { TelegramNotifier } from "./notifiers/telegramNotifier";
import { WhatsAppNotifier } from "./notifiers/whatsappNotifier";
import { logger } from "./utils/logger";
import type { CategoryKey, ShopeeProduct } from "./types/index";
import { SHOPEE_CATEGORIES } from "./types/index";

const SEND_DELAY_MS = 5000;   // pausa entre envios (anti-flood)

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function computeDiscountPct(p: ShopeeProduct): number | null {
  if (p._discountPct !== undefined) return p._discountPct;
  const original = p.originalPrice ?? 0;
  const current = p.priceMin ?? 0;
  if (original <= 0 || current <= 0) return null;
  return ((original - current) / original) * 100;
}

function computeScore(p: ShopeeProduct): number {
  const discount = computeDiscountPct(p) ?? 0;
  const rating = p.itemRating ?? 0;
  const sales = p.sales ?? 0;
  const price = p.priceMin ?? 0;
  const priceScore = price > 0 ? Math.max(0, 30 - Math.log10(price) * 10) : 0;
  const salesScore = Math.log10(sales + 1) * 10;
  return discount * 2 + rating * 5 + salesScore + priceScore;
}

function getDailyRange(now: Date): { start: Date; end: Date } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return { start, end };
}

function getCyclesLeft(now: Date, intervalMinutes: number): number {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  const diffMs = end.getTime() - now.getTime();
  const minutesLeft = Math.max(0, Math.floor(diffMs / 60000));
  return Math.max(1, Math.ceil(minutesLeft / intervalMinutes));
}

export class ShopeeBot {
  private readonly db: DatabaseManager;
  private readonly api: ShopeeClient;
  private readonly filter: ProductFilter;
  private readonly telegram: TelegramNotifier;
  private readonly whatsapp: WhatsAppNotifier;
  private running = false;
  private cronJob: ReturnType<typeof cron.schedule> | null = null;

  constructor() {
    this.db = new DatabaseManager();
    this.api = new ShopeeClient();
    this.filter = new ProductFilter(this.db);
    this.telegram = new TelegramNotifier(this.db);
    this.whatsapp = new WhatsAppNotifier(this.db);
  }

  // ----------------------------------------
  //  Ciclo principal
  // ----------------------------------------
  async runCycle(): Promise<void> {
    if (this.running) {
      logger.warn("Ciclo anterior ainda em execucao. Pulando.");
      return;
    }

    this.running = true;
    logger.info("Iniciando ciclo de promocoes...");

    try {
      // Limpeza simples para manter o banco leve (mantem 90 dias)
      const cleaned = await this.db.cleanupSentOlderThan(90);
      if (cleaned > 0) {
        logger.info(`Limpeza: removidos ${cleaned} envios antigos (>90 dias).`);
      }

      const categories: CategoryKey[] = (
        filterConfig.allowedCategories.length > 0
          ? filterConfig.allowedCategories
          : ["todas"]
      ) as CategoryKey[];

      const allProducts: ShopeeProduct[] = [];
      for (const cat of categories) {
        const products = await this.api.fetchAllOffers({ category: cat, maxPages: 3 });
        allProducts.push(...products);
      }

      const unique = deduplicateById(allProducts);
      logger.info(`Total unico: ${unique.length} produtos`);

      const valid = await this.filter.filterProducts(unique);
      logger.info(`Aprovados: ${valid.length} produtos`);

      const recentSent = await this.db.getRecentSentKeys("telegram", 24);
      const unsent = valid.filter(
        (p) => !recentSent.has(`${p.itemId}:${p.shopId}`)
      );
      if (recentSent.size > 0) {
        logger.info(`Ignorando ja enviados (24h): ${recentSent.size}`);
      }
      logger.info(`Disponiveis para selecao: ${unsent.length} produtos`);

      const now = new Date();
      const daily = getDailyRange(now);
      const sentToday = await this.db.countSentBetween("telegram", daily.start, daily.end);
      const remainingDay = Math.max(0, config.marketing.maxPerDay - sentToday);

      if (remainingDay <= 0) {
        logger.info("Limite diario atingido. Nenhum envio neste ciclo.");
        return;
      }

      const cyclesLeft = getCyclesLeft(now, config.rateLimit.fetchIntervalMinutes);
      const targetPerCycle = Math.max(1, Math.ceil(remainingDay / cyclesLeft));
      const cap = Math.min(config.marketing.maxPerCycle, targetPerCycle, remainingDay);

      // Prioriza por score e exige desconto minimo real
      const byCategory = new Map<string, ShopeeProduct[]>();
      for (const p of unsent) {
        const cat = String(p.catId ?? p.categoryId ?? "");
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)?.push(p);
      }

      const quotaConfig = config.marketing.categoryCaps;
      const categoryBuckets = new Map<string, ShopeeProduct[]>();
      for (const [catId, list] of byCategory.entries()) {
        const scored = list
          .map((p) => ({ p, score: computeScore(p), discount: computeDiscountPct(p) }))
          .filter((x) => x.discount === null || x.discount >= config.marketing.minDiscountToSend)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.p);
        if (scored.length > 0) categoryBuckets.set(catId, scored);
      }

      const totalQualified = Array.from(categoryBuckets.values()).reduce(
        (sum, arr) => sum + arr.length,
        0
      );
      logger.info(`Qualificados para envio neste ciclo: ${totalQualified} | limite do ciclo: ${cap}`);
      if (totalQualified === 0) {
        logger.info(
          `Nenhum produto com desconto >= ${config.marketing.minDiscountToSend}% para envio neste ciclo.`
        );
        return;
      }

      const quotas: Array<{ catId: string; limit: number }> = [];
      for (const [catKey, pct] of Object.entries(quotaConfig)) {
        const id = SHOPEE_CATEGORIES[catKey as CategoryKey];
        if (id === null || id === undefined) continue;
        const limit = Math.max(0, Math.floor(cap * pct));
        quotas.push({ catId: String(id), limit });
      }

      const selected: ShopeeProduct[] = [];
      let remaining = cap;

      for (const q of quotas) {
        if (remaining <= 0) break;
        const list = categoryBuckets.get(q.catId) ?? [];
        const take = Math.min(q.limit, list.length, remaining);
        if (take > 0) {
          selected.push(...list.slice(0, take));
          remaining -= take;
          categoryBuckets.set(q.catId, list.slice(take));
        }
      }

      if (remaining > 0) {
        const leftovers = Array.from(categoryBuckets.values()).flat();
        const scored = leftovers
          .map((p) => ({ p, score: computeScore(p) }))
          .sort((a, b) => b.score - a.score)
          .map((x) => x.p);
        selected.push(...scored.slice(0, remaining));
      }

      const candidates = selected.slice(0, cap);

      if (candidates.length === 0) {
        logger.info("Nenhum produto qualificado para envio neste ciclo.");
        return;
      }

      let sent = 0;
      for (const product of candidates) {
        const originalUrl = product.offerLink ?? product.itemUrl ?? "";
        const affiliateUrl = originalUrl
          ? await this.api.generateAffiliateLink(originalUrl)
          : undefined;

        product._affiliateUrl = affiliateUrl;

        const tg = config.telegram.enabled
          ? await this.telegram.sendProduct(product, affiliateUrl)
          : false;

        const wa = config.whatsapp.enabled
          ? await this.whatsapp.sendProduct(product, affiliateUrl)
          : false;

        if (tg || wa) {
          sent++;
          await sleep(SEND_DELAY_MS);
        }
      }

      logger.info(`Ciclo concluido: ${sent} produtos enviados.`);
    } catch (err) {
      logger.error("Erro no ciclo:", err);
    } finally {
      this.running = false;
    }
  }

  // ----------------------------------------
  //  Inicializacao
  // ----------------------------------------
  async start(): Promise<void> {
    logger.info("Shopee Promo Bot iniciando...");

    await this.db.initialize();
    await this.loadSavedConfig();

    if (config.telegram.enabled) {
      this.telegram.startPolling();
    }

    await this.runCycle();

    const interval = config.rateLimit.fetchIntervalMinutes;
    const cronExpr = `*/${interval} * * * *`;
    this.cronJob = cron.schedule(cronExpr, () => {
      this.runCycle().catch((err) => logger.error("Erro no ciclo agendado:", err));
    });

    logger.info(`Ciclos agendados a cada ${interval} minuto(s).`);

    process.on("SIGINT", () => this.stop("SIGINT"));
    process.on("SIGTERM", () => this.stop("SIGTERM"));
  }

  stop(signal = "manual"): void {
    logger.info(`Encerrando (${signal})...`);
    this.cronJob?.stop();
    this.telegram.stopPolling();
    this.db.close().finally(() => process.exit(0));
  }

  // ----------------------------------------
  //  Config persistida
  // ----------------------------------------
  private async loadSavedConfig(): Promise<void> {
    try {
      const discount = await this.db.getConfig("minDiscountPercent");
      if (discount) {
        const parsed = parseFloat(discount);
        if (!Number.isNaN(parsed)) {
          filterConfig.minDiscountPercent = Math.min(
            filterConfig.minDiscountPercent,
            parsed
          );
        }
      }

      const price = await this.db.getConfig("maxPriceBRL");
      if (price) {
        const parsed = parseFloat(price);
        if (!Number.isNaN(parsed)) {
          filterConfig.maxPriceBRL = Math.max(filterConfig.maxPriceBRL, parsed);
        }
      }
    } catch {
      logger.warn("Nao foi possivel restaurar configuracoes salvas.");
    }
  }
}

// ----------------------------------------
//  Helpers
// ----------------------------------------
function deduplicateById(products: ShopeeProduct[]): ShopeeProduct[] {
  const seen = new Set<string>();
  return products.filter((p) => {
    const key = `${p.itemId}:${p.shopId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
