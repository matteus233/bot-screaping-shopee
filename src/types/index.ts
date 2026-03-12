// src/types/index.ts — Todos os tipos do projeto

// ──────────────────────────────────────────────
//  API Shopee
// ──────────────────────────────────────────────

export interface ShopeeProduct {
  itemId: string;
  shopId: string;
  itemName: string;
  imageUrl?: string;
  offerLink?: string;
  itemUrl?: string;

  // Preços (em centavos ou float dependendo do endpoint)
  priceMin: number;
  priceMax?: number;
  originalPrice: number;

  // Qualidade
  itemRating: number;      // 0–5
  ratingCount?: number;
  rateStar?: number;
  sales: number;

  // Categoria
  catId?: string;
  categoryId?: string;

  // Campos enriquecidos pelo bot (prefixo _)
  _discountPct?: number;
  _historicalMin?: number;
  _affiliateUrl?: string;
}

export interface ShopeeApiResponse<T> {
  code: number;
  msg?: string;
  data?: T;
}

export interface ShopeeOffersData {
  productOffer: ShopeeProduct[];
  totalCount?: number;
}

// ──────────────────────────────────────────────
//  Configuração / Filtros
// ──────────────────────────────────────────────

export interface FilterConfig {
  minDiscountPercent: number;
  maxPriceBRL: number;
  minPriceBRL: number;
  minRating: number;
  minRatingCount: number;
  minSales: number;
  historicalPriceCheck: boolean;
  maxPriceVsHistorical: number;
  keywordsWhitelist: string[];
  keywordsBlacklist: string[];
  allowedCategories: string[];
}

export interface BotConfig {
  shopee: {
    appId: string;
    secret: string;
    affiliateId: string;
    baseUrl: string;
  };
  telegram: {
    token: string;
    channelId: string;
    enabled: boolean;
  };
  whatsapp: {
    accountSid: string;
    authToken: string;
    fromNumber: string;
    toNumber: string;
    enabled: boolean;
  };
  rateLimit: {
    requestsPerMinute: number;
    burstSize: number;
    fetchIntervalMinutes: number;
  };
  filter: FilterConfig;
  databasePath: string;       // SQLite path
  databaseUrl: string;        // PostgreSQL connection URL
  logLevel: string;
}

// ──────────────────────────────────────────────
//  Database
// ──────────────────────────────────────────────

export interface PriceRecord {
  itemId: string;
  shopId: string;
  price: number;
  recordedAt: string;
}

export interface SentRecord {
  itemId: string;
  shopId: string;
  channel: NotificationChannel;
  sentAt: string;
}

export type NotificationChannel = "telegram" | "whatsapp";

// ──────────────────────────────────────────────
//  Filtro
// ──────────────────────────────────────────────

export interface FilterResult {
  passed: boolean;
  reason: string;
}

// ──────────────────────────────────────────────
//  Shopee categories
// ──────────────────────────────────────────────

export type CategoryKey =
  | "eletronicos"
  | "celulares"
  | "computadores"
  | "moda_masculina"
  | "moda_feminina"
  | "casa_decoracao"
  | "beleza"
  | "esportes"
  | "brinquedos"
  | "automotivo"
  | "saude"
  | "livros"
  | "games"
  | "alimentos"
  | "pets"
  | "todas";

export const SHOPEE_CATEGORIES: Record<CategoryKey, number | null> = {
  eletronicos:     11036132,
  celulares:       11044464,
  computadores:    11036278,
  moda_masculina:  11036132,
  moda_feminina:   11036133,
  casa_decoracao:  11036278,
  beleza:          11036279,
  esportes:        11036280,
  brinquedos:      11036281,
  automotivo:      11036282,
  saude:           11036283,
  livros:          11036284,
  games:           11036285,
  alimentos:       11036286,
  pets:            11036287,
  todas:           null,
}
