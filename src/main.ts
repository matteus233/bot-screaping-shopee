// src/main.ts — Ponto de entrada
import { config } from "./config";
import { logger } from "./utils/logger.js";
import { ShopeeBot } from "./scheduler.js";

function validateChannels(): void {
  const active: string[] = [];
  if (config.telegram.enabled) active.push("Telegram");
  if (config.whatsapp.enabled) active.push("WhatsApp");

  if (active.length === 0) {
    logger.error("Configure pelo menos um canal: TELEGRAM_BOT_TOKEN ou TWILIO_ACCOUNT_SID");
    process.exit(1);
  }

  logger.info(`📡 Canais ativos: ${active.join(", ")}`);
}

async function main(): Promise<void> {
  logger.info("═══════════════════════════════════");
  logger.info("   🛍️  Shopee Promo Bot  v1.0.0   ");
  logger.info("═══════════════════════════════════");

  validateChannels();

  const bot = new ShopeeBot();
  await bot.start();
}

main().catch((err) => {
  logger.error("Erro fatal:", err);
  process.exit(1);
});