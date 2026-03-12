// src/notifiers/whatsappNotifier.ts — Notificador WhatsApp via Twilio
import twilio from "twilio";
import { config } from "../config";
import { DatabaseManager } from "../database/dbManager";
import { formatWhatsApp } from "../utils/formatter";
import { logger } from "../utils/logger";
import type { ShopeeProduct } from "../types/index";

export class WhatsAppNotifier {
  private readonly client: ReturnType<typeof twilio> | null = null;
  private readonly db: DatabaseManager;

  constructor(db: DatabaseManager) {
    this.db = db;

    if (config.whatsapp.enabled) {
      this.client = twilio(config.whatsapp.accountSid, config.whatsapp.authToken);
    }
  }

  async sendProduct(product: ShopeeProduct, affiliateUrl?: string): Promise<boolean> {
    if (!config.whatsapp.enabled || !this.client) {
      logger.warn("WhatsApp desabilitado.");
      return false;
    }

    const itemId = String(product.itemId);
    const shopId = String(product.shopId);

    if (await this.db.wasSent(itemId, shopId, "whatsapp")) {
      logger.debug(`[WhatsApp] ${itemId} já enviado recentemente.`);
      return false;
    }

    const body     = formatWhatsApp(product, affiliateUrl);
    const imageUrl = product.imageUrl;

    try {
      const params: Parameters<typeof this.client.messages.create>[0] = {
        from: config.whatsapp.fromNumber,
        to:   config.whatsapp.toNumber,
        body,
      };

      if (imageUrl) params.mediaUrl = [imageUrl];

      await this.client.messages.create(params);

      await this.db.markAsSent(itemId, shopId, "whatsapp");
      logger.info(`[WhatsApp] ✅ ${product.itemName?.slice(0, 50)}`);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[WhatsApp] Erro: ${msg}`);
      return false;
    }
  }
}