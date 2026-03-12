// src/api/shopeeClient.ts — Cliente da API Shopee Affiliates
import axios, { type AxiosInstance } from "axios";
import crypto from "crypto";
import { config } from "../config.js";
import { rateLimiter } from "./rateLimiter.js";
import { logger } from "../utils/logger.js";
import type {
  ShopeeProduct,
  ShopeeApiResponse,
  ShopeeOffersData,
  CategoryKey,
} from "../types/index.js";
import { SHOPEE_CATEGORIES } from "../types/index.js";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

export class ShopeeClient {
  private readonly http: AxiosInstance;
  private readonly appId: string;
  private readonly secret: string;

  constructor() {
    this.appId  = config.shopee.appId;
    this.secret = config.shopee.secret;

    this.http = axios.create({
      baseURL: config.shopee.baseUrl,
      timeout: 15_000,
    });
  }

  // ──────────────────────────────────────────────
  //  Autenticação HMAC-SHA256
  // ──────────────────────────────────────────────
  private sign(timestamp: number): string {
    const payload = `${this.appId}${timestamp}`;
    return crypto
      .createHmac("sha256", this.secret)
      .update(payload)
      .digest("hex");
  }

  private buildHeaders(): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000);
    return {
      Authorization: `SHA256 ${this.appId}:${this.sign(timestamp)}`,
      "Content-Type": "application/json",
      "X-Timestamp": String(timestamp),
    };
  }

  // ──────────────────────────────────────────────
  //  Requisição genérica com retry + rate limit
  // ──────────────────────────────────────────────
  private async get<T>(
    endpoint: string,
    params: Record<string, unknown>,
  ): Promise<T | null> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      await rateLimiter.acquire();

      try {
        const { data } = await this.http.get<ShopeeApiResponse<T>>(endpoint, {
          headers: this.buildHeaders(),
          params,
        });

        if (data.code !== 0) {
          logger.warn(`API erro ${data.code}: ${data.msg} (${endpoint})`);
          return null;
        }

        return data.data ?? null;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Tentativa ${attempt}/${MAX_RETRIES} falhou [${endpoint}]: ${msg}`);

        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt);
        }
      }
    }

    logger.error(`Desistindo após ${MAX_RETRIES} tentativas: ${endpoint}`);
    return null;
  }

  // ──────────────────────────────────────────────
  //  Endpoints
  // ──────────────────────────────────────────────

  /** Lista produtos em promoção (paginado). */
  async getOffers(options: {
    page?: number;
    pageSize?: number;
    categoryId?: number | null;
    keyword?: string;
    sortType?: number;
  }): Promise<ShopeeProduct[]> {
    const { page = 1, pageSize = 50, categoryId, keyword, sortType = 2 } = options;

    const params: Record<string, unknown> = { page, pageSize, sortType };
    if (categoryId) params.categoryId = categoryId;
    if (keyword)    params.keyword    = keyword;

    const data = await this.get<ShopeeOffersData>(
      "/api/v2/affiliate/offer/list",
      params,
    );

    const items = data?.productOffer ?? [];
    logger.info(`Página ${page}: ${items.length} produtos recebidos`);
    return items;
  }

  /** Detalhes completos de um produto (inclui preço histórico). */
  async getProductDetail(itemId: string, shopId: string): Promise<ShopeeProduct | null> {
    return this.get<ShopeeProduct>("/api/v2/affiliate/product/get", {
      itemId,
      shopId,
    });
  }

  /** Converte uma URL normal em link de afiliado. */
  async generateAffiliateLink(originalUrl: string): Promise<string> {
    const data = await this.get<{ generateLink: string }>(
      "/api/v2/affiliate/link/generate",
      { originUrl: originalUrl },
    );
    return data?.generateLink ?? originalUrl;
  }

  /**
   * Varre múltiplas páginas de uma categoria e agrega todos os produtos.
   * Deduplica por (itemId, shopId).
   */
  async fetchAllOffers(options: {
    category?: CategoryKey;
    keyword?: string;
    maxPages?: number;
  }): Promise<ShopeeProduct[]> {
    const { category = "todas", keyword, maxPages = 5 } = options;
    const categoryId = SHOPEE_CATEGORIES[category];

    const all: ShopeeProduct[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= maxPages; page++) {
      const items = await this.getOffers({ page, pageSize: 50, categoryId, keyword });

      if (items.length === 0) break;

      for (const item of items) {
        const key = `${item.itemId}:${item.shopId}`;
        if (!seen.has(key)) {
          seen.add(key);
          all.push(item);
        }
      }

      logger.info(`Total acumulado [${category}]: ${all.length} produtos`);
    }

    return all;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}