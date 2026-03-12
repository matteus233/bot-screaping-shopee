// src/scheduler.ts — Orquestrador principal (node-cron)
import cron from "node-cron";
import { config, filterConfig } from "./config.js";
import { ShopeeClient } from "./api/shopeeClient.js";
import { ProductFilter } from "./filters/productFilter.js";
import { DatabaseManager } from "./database/dbManager.js";
import { TelegramNotifier } from "./notifiers/telegramNotifier.js";
import { WhatsAppNotifier } from "./notifiers/whatsappNotifier.js";
import { logger } from "./utils/logger.js";
import { SHOPEE_CATEGORIES } from "./types/index.js";
import type { CategoryKey, ShopeeProduct } from "./types/index.js";

const SEND_DELAY_MS = 1500;   // pausa entre envios (anti-flood)

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class ShopeeBot {
  private readonly db:        DatabaseManager;
  private readonly api:       ShopeeClient;
  private readonly filter:    ProductFilter;
  private readonly telegram:  TelegramNotifier;
  private readonly whatsapp:  WhatsAppNotifier;
  private running = false;
  private cronJob: ReturnType<typeof cron.schedule> | null = null;

  constructor() {
    this.db        = new DatabaseManager();
    this.api       = new ShopeeClient();
    this.filter    = new ProductFilter(this.db);
    this.telegram  = new TelegramNotifier(this.db);
    this.whatsapp  = new WhatsAppNotifier(this.db);
  }

  // ──────────────────────────────────────────────
  //  Ciclo principal
  // ──────────────────────────────────────────────

  async runCycle(): Promise<void> {
    if (this.running) {
      logger.warn("⚠️  Ciclo anterior ainda em execução. Pulando.");
      return;
    }

    this.running = true;
    logger.info("🔄 Iniciando ciclo de promoções...");

    try {
      // Determina categorias a buscar
      const categories: CategoryKey[] = (
        filterConfig.allowedCategories.length > 0
          ? filterConfig.allowedCategories
          : ["todas"]
      ) as CategoryKey[];

      // Busca em paralelo por categoria (respeitando rate limit via TokenBucket)
      const allProducts: ShopeeProduct[] = [];
      for (const cat of categories) {
        const products = await this.api.fetchAllOffers({ category: cat, maxPages: 3 });
        allProducts.push(...products);
      }

      // Deduplica globalmente
      const unique = deduplicateById(allProducts);
      logger.info(`Total único: ${unique.length} produtos`);

      // Filtra
      const valid = await this.filter.filterProducts(unique);
      logger.info(`Aprovados: ${valid.length} produtos`);

      // Envia
      let sent = 0;
      for (const product of valid) {
        const originalUrl  = product.offerLink ?? product.itemUrl ?? "";
        const affiliateUrl = originalUrl
          ? await this.api.generateAffiliateLink(originalUrl)
          : undefined;

        product._affiliateUrl = affiliateUrl;

        const tg = await this.telegram.sendProduct(product, affiliateUrl);
        const wa = await this.whatsapp.sendProduct(product, affiliateUrl);

        if (tg || wa) {
          sent++;
          await sleep(SEND_DELAY_MS);
        }
      }

      logger.info(`✅ Ciclo concluído: ${sent} produtos enviados.`);
    } catch (err) {
      logger.error("Erro no ciclo:", err);
    } finally {
      this.running = false;
    }
  }

  // ──────────────────────────────────────────────
  //  Inicialização
  // ──────────────────────────────────────────────

  async start(): Promise<void> {
    logger.info("🚀 Shopee Promo Bot iniciando...");

    // Conecta e inicializa o banco
    await this.db.initialize();

    // Restaura configurações persistidas
    await this.loadSavedConfig();

    // Inicia bot de comandos Telegram
    if (config.telegram.enabled) {
      this.telegram.startPolling();
    }

    // Executa imediatamente
    await this.runCycle();

    // Agenda ciclos recorrentes
    const interval = config.rateLimit.fetchIntervalMinutes;
    const cronExpr = `*/${interval} * * * *`;    // a cada N minutos
    this.cronJob = cron.schedule(cronExpr, () => {
      this.runCycle().catch((err) => logger.error("Erro no ciclo agendado:", err));
    });

    logger.info(`⏰ Ciclos agendados a cada ${interval} minuto(s).`);

    // Graceful shutdown
    process.on("SIGINT",  () => this.stop("SIGINT"));
    process.on("SIGTERM", () => this.stop("SIGTERM"));
  }

  stop(signal = "manual"): void {
    logger.info(`🛑 Encerrando (${signal})...`);
    this.cronJob?.stop();
    this.telegram.stopPolling();
    this.db.close().finally(() => process.exit(0));
  }

  // ──────────────────────────────────────────────
  //  Config persistida
  // ──────────────────────────────────────────────

  private async loadSavedConfig(): Promise<void> {
    try {
      const discount = await this.db.getConfig("minDiscountPercent");
      if (discount) filterConfig.minDiscountPercent = parseFloat(discount);

      const price = await this.db.getConfig("maxPriceBRL");
      if (price) filterConfig.maxPriceBRL = parseFloat(price);
    } catch {
      logger.warn("Não foi possível restaurar configurações salvas.");
    }
  }
}

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────
function deduplicateById(products: ShopeeProduct[]): ShopeeProduct[] {
  const seen = new Set<string>();
  return products.filter((p) => {
    const key = `${p.itemId}:${p.shopId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}