// src/notifiers/telegramNotifier.ts — Notificador + bot de comandos via Telegraf
import { Telegraf, type Context } from "telegraf";
import { config, filterConfig } from "../config.js";
import { DatabaseManager } from "../database/dbManager.js";
import { formatTelegram } from "../utils/formatter.js";
import { logger } from "../utils/logger.js";
import { SHOPEE_CATEGORIES } from "../types/index.js";
import type { ShopeeProduct } from "../types/index.js";

export class TelegramNotifier {
  private readonly bot: Telegraf;
  private readonly db: DatabaseManager;
  private readonly channelId: string;

  constructor(db: DatabaseManager) {
    this.db        = db;
    this.channelId = config.telegram.channelId;
    this.bot       = new Telegraf(config.telegram.token);
    this.registerCommands();
  }

  // ──────────────────────────────────────────────
  //  Envio de promoção
  // ──────────────────────────────────────────────

  async sendProduct(product: ShopeeProduct, affiliateUrl?: string): Promise<boolean> {
    if (!config.telegram.enabled) {
      logger.warn("Telegram desabilitado.");
      return false;
    }

    const itemId = String(product.itemId);
    const shopId = String(product.shopId);

    if (await this.db.wasSent(itemId, shopId, "telegram")) {
      logger.debug(`[Telegram] ${itemId} já enviado recentemente.`);
      return false;
    }

    const caption = formatTelegram(product, affiliateUrl);
    const imageUrl = product.imageUrl;

    try {
      if (imageUrl) {
        await this.bot.telegram.sendPhoto(this.channelId, imageUrl, {
          caption,
          parse_mode: "HTML",
        });
      } else {
        await this.bot.telegram.sendMessage(this.channelId, caption, {
          parse_mode: "HTML",
          // link_preview_options handled by telegram
        });
      }

      await this.db.markAsSent(itemId, shopId, "telegram");
      logger.info(`[Telegram] ✅ ${product.itemName?.slice(0, 50)}`);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[Telegram] Erro ao enviar: ${msg}`);
      return false;
    }
  }

  // ──────────────────────────────────────────────
  //  Bot de comandos
  // ──────────────────────────────────────────────

  private registerCommands(): void {
    const bot = this.bot;

    bot.command("start", (ctx) => {
      ctx.replyWithHTML(
        "🤖 <b>Shopee Promo Bot</b> ativo!\n\n" +
        "Comandos:\n" +
        "/status — configurações atuais\n" +
        "/desconto [%] — desconto mínimo\n" +
        "/preco [valor] — preço máximo (R$)\n" +
        "/categoria — escolher categorias\n" +
        "/keyword add|remove|block [palavra]",
      );
    });

    bot.command("status", (ctx) => this.cmdStatus(ctx));
    bot.command("filtros", (ctx) => this.cmdStatus(ctx));

    bot.command("desconto", async (ctx) => {
      const val = parseFloat(ctx.message.text.split(" ")[1] ?? "");
      if (isNaN(val)) return void ctx.reply("Uso: /desconto 30");
      filterConfig.minDiscountPercent = val;
      await this.db.setConfig("minDiscountPercent", String(val));
      ctx.reply(`✅ Desconto mínimo: ${val}%`);
    });

    bot.command("preco", async (ctx) => {
      const val = parseFloat(ctx.message.text.split(" ")[1] ?? "");
      if (isNaN(val)) return void ctx.reply("Uso: /preco 300");
      filterConfig.maxPriceBRL = val;
      await this.db.setConfig("maxPriceBRL", String(val));
      ctx.reply(`✅ Preço máximo: R$ ${val.toFixed(2)}`);
    });

    bot.command("categoria", (ctx) => {
      const cats = Object.keys(SHOPEE_CATEGORIES)
        .map((k) => `• ${k}`)
        .join("\n");
      ctx.reply(
        `Categorias disponíveis:\n${cats}\n\nUso: /setcat eletronicos celulares`,
      );
    });

    bot.command("setcat", (ctx) => {
      const args = ctx.message.text.split(" ").slice(1);
      if (args.includes("todas") || args.length === 0) {
        filterConfig.allowedCategories = [];
        ctx.reply("✅ Todas as categorias ativas.");
      } else {
        filterConfig.allowedCategories = args;
        ctx.reply(`✅ Categorias: ${args.join(", ")}`);
      }
    });

    bot.command("keyword", (ctx) => {
      const [, action, word] = ctx.message.text.split(" ");

      if (!action || !word) {
        return void ctx.reply(
          "Uso:\n/keyword add [palavra]\n/keyword remove [palavra]\n/keyword block [palavra]",
        );
      }

      switch (action.toLowerCase()) {
        case "add":
          filterConfig.keywordsWhitelist.push(word.toLowerCase());
          ctx.reply(`✅ '${word}' adicionado à whitelist`);
          break;
        case "remove":
          filterConfig.keywordsWhitelist = filterConfig.keywordsWhitelist.filter(
            (k) => k !== word.toLowerCase(),
          );
          ctx.reply(`✅ '${word}' removido da whitelist`);
          break;
        case "block":
          filterConfig.keywordsBlacklist.push(word.toLowerCase());
          ctx.reply(`🚫 '${word}' adicionado à blacklist`);
          break;
        default:
          ctx.reply("Ação inválida: use add | remove | block");
      }
    });
  }

  private cmdStatus(ctx: Context): void {
    const cfg = filterConfig;
    ctx.replyWithHTML(
      "📊 <b>Status do Bot</b>\n\n" +
      `• Desconto mínimo: <b>${cfg.minDiscountPercent}%</b>\n` +
      `• Preço máximo: <b>R$ ${cfg.maxPriceBRL.toFixed(0)}</b>\n` +
      `• Avaliação mínima: <b>${cfg.minRating} ⭐</b>\n` +
      `• Vendas mínimas: <b>${cfg.minSales.toLocaleString("pt-BR")}</b>\n` +
      `• Preço histórico: <b>${cfg.historicalPriceCheck ? "✅" : "❌"}</b>\n` +
      `• Categorias: <b>${cfg.allowedCategories.join(", ") || "todas"}</b>\n` +
      `• Whitelist: <b>${cfg.keywordsWhitelist.join(", ") || "—"}</b>\n` +
      `• Blacklist: <b>${cfg.keywordsBlacklist.join(", ") || "—"}</b>`,
    );
  }

  /** Inicia o polling de comandos (não bloqueia). */
  startPolling(): void {
    this.bot.launch().catch((err) => {
      logger.error(`[Telegram] Falha ao iniciar polling: ${err}`);
    });
    process.once("SIGINT",  () => this.bot.stop("SIGINT"));
    process.once("SIGTERM", () => this.bot.stop("SIGTERM"));
    logger.info("[Telegram] Bot de comandos iniciado (polling).");
  }

  stopPolling(): void {
    this.bot.stop();
  }
}