// src/api/shopeeClient.ts - Cliente da API Shopee Affiliates (GraphQL)
import axios, { type AxiosInstance } from "axios";
import crypto from "crypto";
import { config } from "../config";
import { rateLimiter } from "./rateLimiter";
import { logger } from "../utils/logger";
import type { ShopeeProduct, CategoryKey } from "../types/index";
import { SHOPEE_CATEGORIES } from "../types/index";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const CATEGORY_KEYWORDS: Partial<Record<CategoryKey, string>> = {
  beleza: "beleza",
  moda_feminina: "moda feminina",
  casa_decoracao: "casa decoracao",
};

export class ShopeeClient {
  private readonly http: AxiosInstance;
  private readonly appId: string;
  private readonly secret: string;

  constructor() {
    this.appId = config.shopee.appId;
    this.secret = config.shopee.secret;

    this.http = axios.create({
      baseURL: config.shopee.baseUrl,
      timeout: 15_000,
    });
  }

  // ----------------------------------------
  //  Auth header (GraphQL)
  // ----------------------------------------
  private buildHeaders(payload: string): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHash("sha256")
      .update(`${this.appId}${timestamp}${payload}${this.secret}`)
      .digest("hex");

    return {
      Authorization: `SHA256 Credential=${this.appId}, Timestamp=${timestamp}, Signature=${signature}`,
      "Content-Type": "application/json",
      "X-Timestamp": String(timestamp),
    };
  }

  // ----------------------------------------
  //  GraphQL request with retry + rate limit
  // ----------------------------------------
  private async graphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T | null> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      await rateLimiter.acquire();

      const payload = { query, variables };
      const body = JSON.stringify(payload);

      try {
        const response = await this.http.post("", body, {
          headers: this.buildHeaders(body),
        });

        const { data, status } = response;
        if (!data || typeof data !== "object") {
          logger.warn(
            `Resposta inesperada (${status}) em GraphQL: ${JSON.stringify(data)}`
          );
          return null;
        }

        const errors = (data as { errors?: Array<{ message?: string; extensions?: { code?: number; message?: string } }> }).errors;
        if (Array.isArray(errors) && errors.length > 0) {
          const first = errors[0];
          const code = first?.extensions?.code;
          const msg = first?.extensions?.message || first?.message || "Erro GraphQL";
          logger.warn(`API erro ${code ?? "?"}: ${msg}`);
          return null;
        }

        return (data as { data?: T }).data ?? null;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Tentativa ${attempt}/${MAX_RETRIES} falhou [GraphQL]: ${msg}`);

        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt);
        }
      }
    }

    logger.error(`Desistindo apos ${MAX_RETRIES} tentativas: GraphQL`);
    return null;
  }

  // ----------------------------------------
  //  Endpoints
  // ----------------------------------------

  /** Lista produtos em promocao (paginado). */
  async getOffers(options: {
    page?: number;
    pageSize?: number;
    categoryId?: number | null;
    keyword?: string;
    sortType?: number;
  }): Promise<ShopeeProduct[]> {
    const { page = 1, pageSize = 50, categoryId, keyword, sortType = 2 } = options;

    const variables: Record<string, unknown> = {
      page,
      limit: pageSize,
      sortType,
      listType: 1,
    };
    if (keyword) variables.keyword = keyword;

    const query = `
      query ProductOffer($keyword: String, $listType: Int, $sortType: Int, $page: Int, $limit: Int) {
        productOfferV2(
          keyword: $keyword
          listType: $listType
          sortType: $sortType
          page: $page
          limit: $limit
        ) {
          nodes {
            itemId
            productName
            productLink
            offerLink
            imageUrl
            priceMin
            priceMax
            priceDiscountRate
            sales
            ratingStar
            shopId
          }
        }
      }
    `;

    const data = await this.graphql<{ productOfferV2?: { nodes?: Array<Record<string, unknown>> } }>(
      query,
      variables,
    );

    const nodes = data?.productOfferV2?.nodes ?? [];
    const items = nodes.map((n) => {
      const priceMin = Number(n.priceMin ?? 0);
      const priceMax = n.priceMax !== undefined ? Number(n.priceMax) : undefined;
      const discountPct = n.priceDiscountRate !== undefined ? Number(n.priceDiscountRate) : undefined;
      const originalPrice =
        discountPct !== undefined && discountPct > 0
          ? priceMin / (1 - discountPct / 100)
          : priceMax !== undefined
            ? priceMax
            : priceMin;

      return {
        itemId: String(n.itemId ?? ""),
        shopId: String(n.shopId ?? ""),
        itemName: String(n.productName ?? ""),
        imageUrl: n.imageUrl ? String(n.imageUrl) : undefined,
        offerLink: n.offerLink ? String(n.offerLink) : undefined,
        itemUrl: n.productLink ? String(n.productLink) : undefined,
        priceMin,
        priceMax,
        originalPrice,
        itemRating: Number(n.ratingStar ?? 0),
        ratingCount: undefined,
        sales: Number(n.sales ?? 0),
        catId: categoryId ? String(categoryId) : undefined,
        _discountPct: discountPct,
      } as ShopeeProduct;
    });

    logger.info(`Pagina ${page}: ${items.length} produtos recebidos`);
    return items;
  }

  /** Detalhes de um produto. */
  async getProductDetail(itemId: string, shopId: string): Promise<ShopeeProduct | null> {
    const query = `
      query ProductOfferById($itemId: Int, $shopId: Int, $page: Int, $limit: Int) {
        productOfferV2(itemId: $itemId, shopId: $shopId, page: $page, limit: $limit) {
          nodes {
            itemId
            productName
            productLink
            offerLink
            imageUrl
            priceMin
            priceMax
            priceDiscountRate
            sales
            ratingStar
            shopId
          }
        }
      }
    `;

    const data = await this.graphql<{ productOfferV2?: { nodes?: Array<Record<string, unknown>> } }>(
      query,
      { itemId: Number(itemId), shopId: Number(shopId), page: 1, limit: 1 },
    );

    const node = data?.productOfferV2?.nodes?.[0];
    if (!node) return null;

    const priceMin = Number(node.priceMin ?? 0);
    const priceMax = node.priceMax !== undefined ? Number(node.priceMax) : undefined;
    const discountPct = node.priceDiscountRate !== undefined ? Number(node.priceDiscountRate) : undefined;
    const originalPrice =
      discountPct !== undefined && discountPct > 0
        ? priceMin / (1 - discountPct / 100)
        : priceMax !== undefined
          ? priceMax
          : priceMin;

    return {
      itemId: String(node.itemId ?? ""),
      shopId: String(node.shopId ?? ""),
      itemName: String(node.productName ?? ""),
      imageUrl: node.imageUrl ? String(node.imageUrl) : undefined,
      offerLink: node.offerLink ? String(node.offerLink) : undefined,
      itemUrl: node.productLink ? String(node.productLink) : undefined,
      priceMin,
      priceMax,
      originalPrice,
      itemRating: Number(node.ratingStar ?? 0),
      ratingCount: undefined,
      sales: Number(node.sales ?? 0),
      _discountPct: discountPct,
    };
  }

  /** Converte uma URL normal em link de afiliado. */
  async generateAffiliateLink(originalUrl: string): Promise<string> {
    const query = `
      mutation GenerateShortLink($originUrl: String!) {
        generateShortLink(input: { originUrl: $originUrl }) {
          shortLink
        }
      }
    `;

    const data = await this.graphql<{ generateShortLink?: { shortLink?: string } }>(
      query,
      { originUrl: originalUrl },
    );
    return data?.generateShortLink?.shortLink ?? originalUrl;
  }

  /**
   * Varre multiplas paginas de uma categoria e agrega todos os produtos.
   * Deduplica por (itemId, shopId).
   */
  async fetchAllOffers(options: {
    category?: CategoryKey;
    keyword?: string;
    maxPages?: number;
  }): Promise<ShopeeProduct[]> {
    const { category = "todas", keyword, maxPages = 5 } = options;
    const categoryId = SHOPEE_CATEGORIES[category];
    const effectiveKeyword =
      keyword ?? (category !== "todas" ? CATEGORY_KEYWORDS[category] : undefined);

    const all: ShopeeProduct[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= maxPages; page++) {
      const items = await this.getOffers({
        page,
        pageSize: 50,
        categoryId,
        keyword: effectiveKeyword,
      });

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
