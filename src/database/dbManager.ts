// src/database/dbManager.ts - Gerenciador PostgreSQL (pg Pool, totalmente assincrono)
import { Pool, type PoolClient } from "pg";
import { config } from "../config";
import { logger } from "../utils/logger";
import type { NotificationChannel } from "../types/index";

export class DatabaseManager {
  private readonly pool: Pool;

  constructor(connectionString = config.databaseUrl) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: connectionString.includes("sslmode=require")
        ? { rejectUnauthorized: false }
        : undefined,
    });

    this.pool.on("error", (err) => {
      logger.error("Erro inesperado no pool PostgreSQL:", err);
    });
  }

  // ----------------------------------------
  //  Inicializacao - cria tabelas se nao existirem
  // ----------------------------------------
  async initialize(): Promise<void> {
    await this.query(`
      CREATE TABLE IF NOT EXISTS price_history (
        id          BIGSERIAL PRIMARY KEY,
        item_id     TEXT        NOT NULL,
        shop_id     TEXT        NOT NULL,
        price       NUMERIC(12,2) NOT NULL,
        recorded_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_price_item
        ON price_history(item_id, shop_id, recorded_at DESC);

      CREATE TABLE IF NOT EXISTS sent_products (
        id          BIGSERIAL PRIMARY KEY,
        item_id     TEXT        NOT NULL,
        shop_id     TEXT        NOT NULL,
        channel     TEXT        NOT NULL,
        sent_at     TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_sent UNIQUE (item_id, shop_id, channel)
      );

      CREATE TABLE IF NOT EXISTS bot_config (
        key         TEXT PRIMARY KEY,
        value       TEXT        NOT NULL,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    logger.info("Banco de dados (PostgreSQL) inicializado.");
  }

  // ----------------------------------------
  //  Helpers internos
  // ----------------------------------------
  private async query<T extends object = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<T>(sql, params);
      return result.rows;
    } finally {
      client.release();
    }
  }

  /** Executa multiplas queries dentro de uma unica transacao. */
  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // ----------------------------------------
  //  Historico de precos
  // ----------------------------------------
  async recordPrice(itemId: string, shopId: string, price: number): Promise<void> {
    await this.query(
      "INSERT INTO price_history (item_id, shop_id, price) VALUES ($1, $2, $3)",
      [itemId, shopId, price],
    );
  }

  async getHistoricalMinPrice(
    itemId: string,
    shopId: string,
    days = 90,
  ): Promise<number | null> {
    const rows = await this.query<{ min_price: string | null }>(
      `SELECT MIN(price) AS min_price
       FROM price_history
       WHERE item_id = $1
         AND shop_id = $2
         AND recorded_at >= NOW() - ($3 || ' days')::INTERVAL`,
      [itemId, shopId, days],
    );

    const raw = rows[0]?.min_price;
    return raw !== null && raw !== undefined ? parseFloat(raw) : null;
  }

  async getPriceTrend(
    itemId: string,
    shopId: string,
    limit = 30,
  ): Promise<Array<{ date: string; price: number }>> {
    const rows = await this.query<{ date: string; price: string }>(
      `SELECT recorded_at AS date, price
       FROM price_history
       WHERE item_id = $1 AND shop_id = $2
       ORDER BY recorded_at DESC
       LIMIT $3`,
      [itemId, shopId, limit],
    );

    return rows.map((r) => ({ date: r.date, price: parseFloat(r.price) }));
  }

  // ----------------------------------------
  //  Anti-spam (controle de envios)
  // ----------------------------------------
  async wasSent(
    itemId: string,
    shopId: string,
    channel: NotificationChannel,
    cooldownHours = 24,
  ): Promise<boolean> {
    const rows = await this.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM sent_products
         WHERE item_id = $1
           AND shop_id = $2
           AND channel = $3
           AND sent_at >= NOW() - ($4 || ' hours')::INTERVAL
       ) AS exists`,
      [itemId, shopId, channel, cooldownHours],
    );

    return rows[0]?.exists === true;
  }

  async markAsSent(
    itemId: string,
    shopId: string,
    channel: NotificationChannel,
  ): Promise<void> {
    await this.query(
      `INSERT INTO sent_products (item_id, shop_id, channel)
       VALUES ($1, $2, $3)
       ON CONFLICT ON CONSTRAINT uq_sent
       DO UPDATE SET sent_at = NOW()`,
      [itemId, shopId, channel],
    );
  }

  async reserveSend(
    itemId: string,
    shopId: string,
    channel: NotificationChannel,
  ): Promise<boolean> {
    const rows = await this.query<{ id: string }>(
      `INSERT INTO sent_products (item_id, shop_id, channel)
       VALUES ($1, $2, $3)
       ON CONFLICT ON CONSTRAINT uq_sent DO NOTHING
       RETURNING id`,
      [itemId, shopId, channel],
    );
    return rows.length > 0;
  }

  async reserveSendWithCooldown(
    itemId: string,
    shopId: string,
    channel: NotificationChannel,
    cooldownHours = 24,
  ): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const exists = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM sent_products
           WHERE item_id = $1
             AND shop_id = $2
             AND channel = $3
             AND sent_at >= NOW() - ($4 || ' hours')::INTERVAL
         ) AS exists`,
        [itemId, shopId, channel, cooldownHours],
      );

      if (exists.rows[0]?.exists === true) return false;

      // Allow re-send after cooldown by removing old record, then reserving
      await client.query(
        `DELETE FROM sent_products
         WHERE item_id = $1 AND shop_id = $2 AND channel = $3`,
        [itemId, shopId, channel],
      );

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO sent_products (item_id, shop_id, channel)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [itemId, shopId, channel],
      );

      return inserted.rows.length > 0;
    });
  }

  async unmarkAsSent(
    itemId: string,
    shopId: string,
    channel: NotificationChannel,
  ): Promise<void> {
    await this.query(
      `DELETE FROM sent_products
       WHERE item_id = $1 AND shop_id = $2 AND channel = $3`,
      [itemId, shopId, channel],
    );
  }

  async countSentBetween(
    channel: NotificationChannel,
    start: Date,
    end: Date,
  ): Promise<number> {
    const rows = await this.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM sent_products
       WHERE channel = $1
         AND sent_at >= $2
         AND sent_at < $3`,
      [channel, start.toISOString(), end.toISOString()],
    );
    return parseInt(rows[0]?.count ?? "0", 10);
  }

  async getRecentSentKeys(
    channel: NotificationChannel,
    cooldownHours = 24,
  ): Promise<Set<string>> {
    const rows = await this.query<{ item_id: string; shop_id: string }>(
      `SELECT item_id, shop_id
       FROM sent_products
       WHERE channel = $1
         AND sent_at >= NOW() - ($2 || ' hours')::INTERVAL`,
      [channel, cooldownHours],
    );
    const set = new Set<string>();
    for (const r of rows) {
      set.add(`${r.item_id}:${r.shop_id}`);
    }
    return set;
  }

  // ----------------------------------------
  //  Configuracao dinamica do bot
  // ----------------------------------------
  async setConfig(key: string, value: string): Promise<void> {
    await this.query(
      `INSERT INTO bot_config (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value],
    );
  }

  async getConfig(key: string, defaultValue = ""): Promise<string> {
    const rows = await this.query<{ value: string }>(
      "SELECT value FROM bot_config WHERE key = $1",
      [key],
    );
    return rows[0]?.value ?? defaultValue;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

