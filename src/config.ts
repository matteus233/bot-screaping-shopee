// src/config.ts
import "dotenv/config";
import { z } from "zod";
import type { BotConfig, FilterConfig } from "./types/index";

const EnvSchema = z.object({
  SHOPEE_APP_ID: z.string().min(1),
  SHOPEE_SECRET: z.string().min(1),
  SHOPEE_AFFILIATE_ID: z.string().default(""),

  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_CHANNEL_ID: z.string().default(""),

  TWILIO_ACCOUNT_SID: z.string().default(""),
  TWILIO_AUTH_TOKEN: z.string().default(""),
  TWILIO_WHATSAPP_FROM: z.string().default(""),
  WHATSAPP_TO: z.string().default(""),

  DATABASE_PATH: z.string().default("./data/shopee_bot.db"),
  DATABASE_URL: z.string().min(1),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Erro nas variaveis de ambiente:");
  parsed.error.issues.forEach((i) =>
    console.error(`• ${i.path.join(".")}: ${i.message}`)
  );
  process.exit(1);
}

const env = parsed.data;

export const filterConfig: FilterConfig = {
  minDiscountPercent: 10,
  maxPriceBRL: 500,
  minPriceBRL: 5,
  minRating: 4,
  minRatingCount: 5,
  minSales: 10,
  historicalPriceCheck: false,
  maxPriceVsHistorical: 1.05,
  keywordsWhitelist: [],
  keywordsBlacklist: ["replica", "falsificado", "imitacao"],
  allowedCategories: ["beleza", "moda_feminina", "casa_decoracao"],
};

export const config: BotConfig = {
  shopee: {
    appId: env.SHOPEE_APP_ID,
    secret: env.SHOPEE_SECRET,
    affiliateId: env.SHOPEE_AFFILIATE_ID,
    baseUrl: "https://open-api.affiliate.shopee.com.br/graphql",
  },

  telegram: {
    token: env.TELEGRAM_BOT_TOKEN,
    channelId: env.TELEGRAM_CHANNEL_ID,
    enabled: Boolean(env.TELEGRAM_BOT_TOKEN),
  },

  whatsapp: {
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    fromNumber: env.TWILIO_WHATSAPP_FROM,
    toNumber: env.WHATSAPP_TO,
    enabled: Boolean(env.TWILIO_ACCOUNT_SID),
  },

  rateLimit: {
    requestsPerMinute: 60,
    burstSize: 10,
    fetchIntervalMinutes: 60,
  },

  marketing: {
    maxPerDay: 250,
    maxPerCycle: 12,
    minDiscountToSend: 20,
    windowCaps: {
      morning: 70,
      afternoon: 80,
      night: 100,
    },
    categoryCaps: {
      beleza: 0.4,
      moda_feminina: 0.3,
      casa_decoracao: 0.3,
    },
  },

  filter: filterConfig,

  databasePath: env.DATABASE_PATH,
  databaseUrl: env.DATABASE_URL,

  logLevel: env.LOG_LEVEL,
};

