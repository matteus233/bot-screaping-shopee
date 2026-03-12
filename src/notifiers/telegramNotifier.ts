// src/notifiers/telegramNotifier.ts — Notificador + bot de comandos via Telegraf
import { Telegraf, type Context } from "telegraf";
import { config, filterConfig } from "../config";
import { DatabaseManager } from "../database/dbManager";
import { formatTelegram } from "../utils/formatter";
import { logger } from "../utils/logger";
import { SHOPEE_CATEGORIES } from "../types/index";
import type { ShopeeProduct } from "../types/index";

export class TelegramNotifier {
  private readonly bot: Telegraf;
  private readonly db: DatabaseManager;
  private readonly channelId: string;
  private readonly lastForwardedByUser = new Map<number, { id: number; title?: string; type?: string; ts: number }>();
  private lastPrivateUserId: number | null = null;

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

    bot.on("message", (ctx) => {
      if (ctx.chat?.type === "private" && ctx.from?.id) {
        this.lastPrivateUserId = ctx.from.id;
      }
    });

    bot.on("message", (ctx) => {
      const msg = ctx.message as
        | (typeof ctx.message & { forward_from_chat?: { id: number; title?: string; type?: string } })
        | undefined;
      const fwd = msg?.forward_from_chat;
      if (fwd?.id && ctx.from?.id) {
        this.lastForwardedByUser.set(ctx.from.id, {
          id: fwd.id,
          title: fwd.title,
          type: fwd.type,
          ts: Date.now(),
        });
      }
    });

    bot.on("channel_post", (ctx) => {
      const post = ctx.update.channel_post;
      const chatId = post?.chat?.id;
      const title = post?.chat?.title;
      if (chatId) {
        const text = `chatId do canal: ${chatId}${title ? ` (${title})` : ""}`;
        if (this.lastPrivateUserId) {
          this.bot.telegram.sendMessage(this.lastPrivateUserId, text).catch(() => {
            logger.info(`[Telegram] ${text}`);
          });
        } else {
          logger.info(`[Telegram] ${text}`);
        }
      }
    });

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

    bot.command("chatid", (ctx) => {
      const msg = ctx.message as
        | (typeof ctx.message & {
            forward_from_chat?: { id: number; title?: string; type?: string };
            reply_to_message?: { forward_from_chat?: { id: number; title?: string; type?: string } };
          })
        | undefined;

      const forwarded = msg?.forward_from_chat ?? msg?.reply_to_message?.forward_from_chat;
      if (forwarded?.id) {
        const name = forwarded.title ? ` (${forwarded.title})` : "";
        const type = forwarded.type ?? "unknown";
        return void ctx.reply(`chatId: ${forwarded.id} | tipo: ${type}${name}`);
      }

      const cached = ctx.from?.id ? this.lastForwardedByUser.get(ctx.from.id) : undefined;
      if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
        const name = cached.title ? ` (${cached.title})` : "";
        const type = cached.type ?? "unknown";
        return void ctx.reply(`chatId: ${cached.id} | tipo: ${type}${name}`);
      }

      const chat = ctx.chat;
      const chatId = chat?.id;
      const type = chat?.type ?? "unknown";
      const title = (chat && "title" in chat) ? (chat as { title?: string }).title : undefined;
      const name = title ? ` (${title})` : "";
      ctx.reply(
        `chatId: ${chatId} | tipo: ${type}${name}\n` +
        "Dica: para pegar o ID do canal, encaminhe uma mensagem do canal para o bot e rode /chatid."
      );
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

