// src/notifiers/telegramNotifier.ts - Notificador + bot de comandos via Telegraf
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
  private pollOffset = 0;
  private polling = false;

  constructor(db: DatabaseManager) {
    this.db = db;
    this.channelId = config.telegram.channelId;
    this.bot = new Telegraf(config.telegram.token);
    this.registerCommands();
  }

  async sendProduct(product: ShopeeProduct, affiliateUrl?: string): Promise<boolean> {
    if (!config.telegram.enabled) {
      logger.warn("Telegram desabilitado.");
      return false;
    }

    const itemId = String(product.itemId);
    const shopId = String(product.shopId);

    if (await this.db.wasSent(itemId, shopId, "telegram")) {
      logger.debug(`[Telegram] ${itemId} ja enviado recentemente.`);
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
        });
      }

      await this.db.markAsSent(itemId, shopId, "telegram");
      logger.info(`[Telegram] OK ${product.itemName?.slice(0, 50)}`);

      await this.notifyAlerts(product, affiliateUrl);

      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[Telegram] Erro ao enviar: ${msg}`);
      return false;
    }
  }

  async notifyAlerts(product: ShopeeProduct, affiliateUrl?: string): Promise<void> {
    const itemId = String(product.itemId);
    const shopId = String(product.shopId);

    const alerts = await this.db.getAlertsToNotify({
      itemId,
      shopId,
      name: product.itemName ?? "",
    });
    for (const a of alerts) {
      const note =
        `Alerta: produto encontrado\n` +
        `${product.itemName ?? "Produto"}\n` +
        `${affiliateUrl ?? product.offerLink ?? product.itemUrl ?? ""}`;
      await this.bot.telegram.sendMessage(String(a.chatId), note).catch(() => {});
    }
  }

  private registerCommands(): void {
    const bot = this.bot;

    bot.catch((err, ctx) => {
      logger.error(`[Telegram] Erro no bot: ${err}`);
      if (ctx?.chat?.id) {
        this.bot.telegram.sendMessage(ctx.chat.id, "Houve um erro ao processar o comando.").catch(() => {});
      }
    });

    bot.on("message", (ctx, next) => {
      if (ctx.chat?.type === "private" && ctx.from?.id) {
        this.lastPrivateUserId = ctx.from.id;
      }
      return next();
    });

    bot.on("text", async (ctx, next) => {
      const text = ctx.message.text ?? "";
      logger.info(`[Telegram] Mensagem recebida: ${ctx.chat?.type} | ${text}`);

      // Fallback handlers when Telegram doesn't mark commands properly
      if (/^\/?ping\b/i.test(text)) {
        await ctx.reply("pong");
        return next();
      }
      if (/^\/alert\b/i.test(text)) {
        await this.handleAlertCommand(ctx, text);
        return next();
      }
      return next();
    });

    bot.on("message", (ctx, next) => {
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
      return next();
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
        "<b>Shopee Promo Bot</b> ativo!\n\n" +
        "Comandos:\n" +
        "/status - configuracoes atuais\n" +
        "/desconto [%] - desconto minimo\n" +
        "/preco [valor] - preco maximo (R$)\n" +
        "/categoria - escolher categorias\n" +
        "/keyword add|remove|block [palavra]\n" +
        "/alert [palavra|link]\n" +
        "/alertlist | /alertremove [id] | /alertclear\n" +
        "/alerthelp",
      );
    });

    bot.command("ping", (ctx) => {
      ctx.reply("pong");
    });

    bot.command("status", (ctx) => this.cmdStatus(ctx));
    bot.command("filtros", (ctx) => this.cmdStatus(ctx));

    bot.command("desconto", async (ctx) => {
      const val = parseFloat(ctx.message.text.split(" ")[1] ?? "");
      if (isNaN(val)) return void ctx.reply("Uso: /desconto 30");
      filterConfig.minDiscountPercent = val;
      await this.db.setConfig("minDiscountPercent", String(val));
      ctx.reply(`Desconto minimo: ${val}%`);
    });

    bot.command("preco", async (ctx) => {
      const val = parseFloat(ctx.message.text.split(" ")[1] ?? "");
      if (isNaN(val)) return void ctx.reply("Uso: /preco 300");
      filterConfig.maxPriceBRL = val;
      await this.db.setConfig("maxPriceBRL", String(val));
      ctx.reply(`Preco maximo: R$ ${val.toFixed(2)}`);
    });

    bot.command("categoria", (ctx) => {
      const cats = Object.keys(SHOPEE_CATEGORIES)
        .map((k) => `- ${k}`)
        .join("\n");
      ctx.reply(
        `Categorias disponiveis:\n${cats}\n\nUso: /setcat eletronicos celulares`,
      );
    });

    bot.command("setcat", (ctx) => {
      const args = ctx.message.text.split(" ").slice(1);
      if (args.includes("todas") || args.length === 0) {
        filterConfig.allowedCategories = [];
        ctx.reply("Todas as categorias ativas.");
      } else {
        filterConfig.allowedCategories = args;
        ctx.reply(`Categorias: ${args.join(", ")}`);
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
          ctx.reply(`'${word}' adicionado a whitelist`);
          break;
        case "remove":
          filterConfig.keywordsWhitelist = filterConfig.keywordsWhitelist.filter(
            (k) => k !== word.toLowerCase(),
          );
          ctx.reply(`'${word}' removido da whitelist`);
          break;
        case "block":
          filterConfig.keywordsBlacklist.push(word.toLowerCase());
          ctx.reply(`'${word}' adicionado a blacklist`);
          break;
        default:
          ctx.reply("Acao invalida: use add | remove | block");
      }
    });

    bot.command("alert", async (ctx) => {
      return void this.handleAlertCommand(ctx, ctx.message.text);
    });

    bot.command("alertlist", async (ctx) => {
      const list = await this.db.listAlerts(ctx.from.id);
      if (list.length === 0) {
        return void ctx.reply("Voce nao tem alertas ativos.");
      }
      const lines = list.map((a) => {
        if (a.itemId && a.shopId) return `#${a.id} produto ${a.itemId}`;
        return `#${a.id} palavra "${a.keyword}"`;
      });
      ctx.reply(`Seus alertas:\n${lines.join("\n")}`);
    });

    bot.command("alertremove", async (ctx) => {
      const id = parseInt(ctx.message.text.split(" ")[1] ?? "", 10);
      if (Number.isNaN(id)) return void ctx.reply("Uso: /alertremove 123");
      const ok = await this.db.removeAlert(ctx.from.id, id);
      ctx.reply(ok ? "Alerta removido." : "Alerta nao encontrado.");
    });

    bot.command("alertclear", async (ctx) => {
      const count = await this.db.clearAlerts(ctx.from.id);
      ctx.reply(`Alertas removidos: ${count}`);
    });

    bot.command("alerthelp", (ctx) => {
      ctx.reply(
        "Alertas:\n" +
        "/alert hidratante\n" +
        "/alert protetor solar\n" +
        "/alert https://shopee.com.br/... (link do produto)\n\n" +
        "Gerenciar:\n" +
        "/alertlist\n" +
        "/alertremove 123\n" +
        "/alertclear"
      );
    });

    bot.command("alerttest", async (ctx) => {
      if (ctx.chat?.type !== "private") {
        return void ctx.reply("Para testar alertas, fale comigo no privado.");
      }
      const list = await this.db.listAlerts(ctx.from.id);
      if (list.length === 0) {
        return void ctx.reply("Crie um alerta primeiro com /alert.");
      }
      await this.bot.telegram.sendMessage(String(ctx.from.id), "Teste de alerta: este e um aviso simulado.");
      ctx.reply("Teste enviado no privado.");
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

  private async handleAlertCommand(ctx: Context, rawText: string): Promise<void> {
    if (ctx.chat?.type !== "private") {
      return void ctx.reply("Para receber alertas, fale comigo no privado.");
    }
    if (!ctx.from?.id) {
      return void ctx.reply("Nao foi possivel identificar o usuario.");
    }
    try {
      const text = rawText.split(" ").slice(1).join(" ").trim();
      if (!text) {
        return void ctx.reply(
          "Uso: /alert [palavra-chave ou link Shopee]\nEx: /alert hidratante"
        );
      }

      const match = text.match(/i\.(\d+)\.(\d+)/);
      if (match) {
        const [, shopId, itemId] = match;
        const id = await this.db.addAlert({
          userId: ctx.from.id,
          chatId: ctx.from.id,
          itemId,
          shopId,
        });
        return void ctx.reply(`Alerta criado (#${id}) para o produto ${itemId}.`);
      }

      const keyword = text.toLowerCase();
      const id = await this.db.addAlert({
        userId: ctx.from.id,
        chatId: ctx.from.id,
        keyword,
      });
      return void ctx.reply(`Alerta criado (#${id}) para a palavra "${keyword}".`);
    } catch (err) {
      logger.error(`[Telegram] Erro ao criar alerta: ${err}`);
      return void ctx.reply("Erro ao criar alerta. Tente novamente.");
    }
  }

  private cmdStatus(ctx: Context): void {
    const cfg = filterConfig;
    ctx.replyWithHTML(
      "<b>Status do Bot</b>\n\n" +
      `- Desconto minimo: <b>${cfg.minDiscountPercent}%</b>\n` +
      `- Preco maximo: <b>R$ ${cfg.maxPriceBRL.toFixed(0)}</b>\n` +
      `- Avaliacao minima: <b>${cfg.minRating}</b>\n` +
      `- Vendas minimas: <b>${cfg.minSales.toLocaleString("pt-BR")}</b>\n` +
      `- Preco historico: <b>${cfg.historicalPriceCheck ? "sim" : "nao"}</b>\n` +
      `- Categorias: <b>${cfg.allowedCategories.join(", ") || "todas"}</b>\n` +
      `- Whitelist: <b>${cfg.keywordsWhitelist.join(", ") || "-"}</b>\n` +
      `- Blacklist: <b>${cfg.keywordsBlacklist.join(", ") || "-"}</b>`,
    );
  }

  startPolling(): void {
    this.bot.telegram.getMe().then((me) => {
      logger.info(`[Telegram] Bot conectado: ${me.username} (${me.id})`);
    }).catch((err) => {
      logger.error(`[Telegram] Falha ao obter bot info: ${err}`);
    });

    this.bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});

    if (this.polling) return;
    this.polling = true;

    const poll = async () => {
      if (!this.polling) return;
      try {
        const updates = await this.bot.telegram.getUpdates(10, 50, this.pollOffset, undefined);
        if (updates.length > 0) {
          logger.info(`[Telegram] Poll updates: ${updates.length} (offset ${this.pollOffset})`);
        }
        for (const upd of updates) {
          const msg = (upd as { message?: { text?: string; chat?: { type?: string }; from?: { id?: number } } })
            .message;
          const text = msg?.text ?? "";
          const chatType = msg?.chat?.type ?? "unknown";
          const fromId = msg?.from?.id ?? "unknown";
          const chatId = msg?.chat && "id" in msg.chat ? (msg.chat as { id: number }).id : undefined;
          // logs detalhados de update removidos para reduzir ruido
          if (chatId && /^\/?ping\b/i.test(text)) {
            await this.bot.telegram.sendMessage(chatId, "pong").catch((err) => {
              logger.error(`[Telegram] Falha no fallback ping: ${err}`);
            });
          }
          await this.bot.handleUpdate(upd);
        }
        if (updates.length > 0) {
          const lastId = updates[updates.length - 1].update_id;
          this.pollOffset = lastId + 1;
        }
      } catch (err) {
        logger.error(`[Telegram] Erro no polling manual: ${err}`);
      } finally {
        setTimeout(poll, 1000);
      }
    };

    poll().catch(() => {});
    process.once("SIGINT", () => this.stopPolling());
    process.once("SIGTERM", () => this.stopPolling());
    logger.info("[Telegram] Bot de comandos iniciado (polling manual).");
  }

  stopPolling(): void {
    this.polling = false;
    this.bot.stop();
  }
}




