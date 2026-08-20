# BCV Scraper

Pipeline confiable de tasas de cambio del BCV (Banco Central de Venezuela): n8n scrapea `bcv.org.ve`, valida y envía a un Worker de Cloudflare que persiste en D1 y expone una API pública de consulta en `https://bcv-api.sisteg.net`.

**Estado: en producción.** Verificado end-to-end el 2026-08-20 — ver [Pruebas realizadas](#pruebas-realizadas).

## Arquitectura

```
n8n (Contabo VPS, Docker)                       Cloudflare
┌───────────────────────────┐            ┌──────────────────────────────┐
│ Schedule Trigger            │            │  Worker: bcv-rate-api          │
│  */30min 15-23h L-V UTC     │            │  dominio: bcv-api.sisteg.net   │
│  + 12:00 UTC diario          │            │  ┌───────────────────────────┐│
│         │                    │            │  │ POST /ingest  (auth)        ││
│ Fetch BCV Page (HTML)        │            │  │ GET  /rates/latest[/CCY]    ││
│         │                    │──────────▶ │  │ GET  /rates/history         ││
│ Parse & Validate (Code)      │  POST      │  │ GET  /health                 ││
│  extrae USD/EUR/CNY/TRY/RUB  │  /ingest   │  │ scheduled(): watchdog        ││
│  + Fecha Valor                │            │  │  diario 03:00 UTC            ││
│         │                    │            │  └──────────────┬────────────┘│
│ IF: fecha nueva? ──No──▶ No-op            │                 │             │
│         │Sí                  │            │                 ▼             │
│ POST /ingest ──error──┐      │            │           D1: bcv_rates       │
│                        │      │            └────────────────┬────────────┘
│                        ▼      │                              │ alerta si no
│              Notify Error     │                              │ hay tasa hoy
│           (Execute Workflow,  │                              │ (webhook público,
│            interno, sin red)  │                              │  ver nota abajo)
└───────────┬────────────────┘                              │
            ▼                                                 │
  BCV Scraper — Alertas a Notion  ◀─────────────────────────────┘
   (Webhook + Execute Workflow Trigger → Format Alert → HTTP a Notion API)
            │
            ▼
   Notion: base "BCV Scraper — Alertas"
```

- **n8n** (workflows "BCV Rate Scraper" y "BCV Scraper — Alertas a Notion", viven en la instancia n8n, `n8n/bcv-scraper-workflow.json` queda solo como referencia histórica del diseño original): scraping cada 30 min en horario hábil de BCV + 1 corrida diaria de respaldo, parsea el HTML con regex (sin dependencias externas), valida que las 5 monedas y la fecha valor existan, y solo llama a `/ingest` si la fecha cambió respecto a la última tasa conocida (evita escrituras redundantes). Los errores se notifican internamente (Execute Workflow, sin salir a internet) al workflow que los registra en Notion.
- **Worker** (`src/index.js`): valida el token de ingesta, rechaza saltos anómalos de tasa (>15% día a día, se registra en `scrape_log` pero no bloquea otras monedas), hace upsert en D1, y expone lectura pública (`latest`, `history`). Su propio cron (`wrangler.toml`, `0 3 * * *`) es un watchdog independiente: si a esa hora no hay tasa USD del día, notifica a un webhook.
- **D1** (`schema.sql`): `exchange_rates` (unique por `currency+value_date`) y `scrape_log` (auditoría de cada corrida/rechazo).

## Cómo consultar la API

Base URL: **`https://bcv-api.sisteg.net`** (dominio propio sobre el Worker `bcv-rate-api`; el `*.workers.dev` original sigue funcionando como alias pero usa el dominio propio en integraciones nuevas).

Todos los endpoints de lectura son públicos (`GET`, sin autenticación, CORS abierto `Access-Control-Allow-Origin: *`). Solo `/ingest` requiere token — no es de uso público, lo usa el scraper de n8n.

### `GET /health`
Liveness check.

```bash
curl https://bcv-api.sisteg.net/health
```
```json
{"ok":true}
```

### `GET /rates/latest`
Todas las monedas de la última fecha valor disponible.

```bash
curl https://bcv-api.sisteg.net/rates/latest
```
```json
[
  {"id":1,"currency":"USD","rate":777.4161,"value_date":"2026-08-20","scraped_at":"2026-08-20T09:09:02.290Z"},
  {"id":2,"currency":"EUR","rate":906.83255816,"value_date":"2026-08-20","scraped_at":"2026-08-20T09:09:02.290Z"},
  {"id":3,"currency":"CNY","rate":115.54420878,"value_date":"2026-08-20","scraped_at":"2026-08-20T09:09:02.290Z"},
  {"id":4,"currency":"TRY","rate":16.42292139,"value_date":"2026-08-20","scraped_at":"2026-08-20T09:09:02.290Z"},
  {"id":5,"currency":"RUB","rate":9.15253237,"value_date":"2026-08-20","scraped_at":"2026-08-20T09:09:02.290Z"}
]
```
`404 {"error":"sin datos"}` si la tabla está vacía.

### `GET /rates/latest/:currency`
Última tasa de una sola moneda. `:currency` es uno de `USD`, `EUR`, `CNY`, `TRY`, `RUB` (mayúsculas o minúsculas, se normaliza).

```bash
curl https://bcv-api.sisteg.net/rates/latest/USD
```
```json
{"id":1,"currency":"USD","rate":777.4161,"value_date":"2026-08-20","scraped_at":"2026-08-20T09:09:02.290Z"}
```
`404 {"error":"sin datos"}` si no hay ninguna tasa para esa moneda todavía.

### `GET /rates/history?currency=USD&limit=30`
Histórico descendente por fecha. `currency` es obligatorio; `limit` es opcional (default `30`).

```bash
curl "https://bcv-api.sisteg.net/rates/history?currency=USD&limit=5"
```
```json
[
  {"currency":"USD","rate":777.4161,"value_date":"2026-08-20"}
]
```
`400 {"error":"currency invalida"}` si falta `currency` o no es una de las 5 soportadas.

### `POST /ingest` (uso interno del scraper, no público)
```
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json

{
  "valueDate": "2026-08-20",
  "scrapedAt": "2026-08-20T09:09:02.290Z",
  "rates": { "USD": 777.4161, "EUR": 906.83255816, "CNY": 115.54420878, "TRY": 16.42292139, "RUB": 9.15253237 }
}
```
`401` si el Bearer token no coincide con el secret `INGEST_TOKEN` del Worker. Por moneda: `rejected_anomaly` si el delta contra la tasa anterior supera 15% (se guarda igual en `scrape_log`, no se actualiza `exchange_rates`).

## Pruebas realizadas

Verificado el 2026-08-20 contra producción (`https://bcv-api.sisteg.net`), con datos reales ya ingeridos por el scraper:

| Prueba | Resultado |
|---|---|
| `GET /health` | `200 {"ok":true}` |
| `GET /rates/latest` | `200`, 5 monedas, `value_date: 2026-08-20` |
| `GET /rates/latest/USD` | `200`, tasa USD individual correcta |
| `GET /rates/history?currency=USD&limit=5` | `200`, histórico (1 registro, es el primer día con datos) |
| `GET /ingest` (sin auth, método incorrecto) | `404` — correcto, esa ruta solo maneja `POST` |

Pendiente de probar cuando haya más de un día de histórico: rotación de `value_date`, detección de anomalía >15%, y el watchdog diario de las 03:00 UTC (bloqueado hoy por el issue de Cloudflare de la sección siguiente).

## Variables de entorno (Worker)

Definidas como *secrets* (no van en `wrangler.toml`, ver `.dev.vars.example` para desarrollo local):

- `INGEST_TOKEN` — token compartido con la credencial "BCV Ingest Token" en n8n. **Configurado.**
- `ALERT_WEBHOOK_URL` — webhook (n8n) que recibe la alerta del watchdog diario. **Configurado**, pero ver limitación abajo.

## Limitación conocida — watchdog del Worker

El watchdog (`scheduled()`, cron `0 3 * * *`) llama a `ALERT_WEBHOOK_URL` desde el edge de Cloudflare hacia el dominio de n8n (`vmi2945958.contaboserver.net`). Ese dominio está devolviendo un challenge de Cloudflare (403, página "Just a moment...") a llamadas servidor-a-servidor, así que esta alerta específica no llega todavía. **No afecta las alertas del propio scraper** (esas van por un nodo Execute Workflow interno en n8n, sin salir a internet). Pendiente: decidir el fix correcto en el dashboard de Cloudflare (WAF/Bot Fight Mode) — requiere saber si `vmi2945958.contaboserver.net` está en una zona Cloudflare propia o es el hostname genérico de Contabo. Detalle completo en `HANDOFF.md`.

## Estado del repo / pendientes

1. `n8n/bcv-scraper-workflow.json` es el diseño original (referencia histórica) — el workflow real vive en n8n, con `apiUrl = https://bcv-api.sisteg.net` ya configurado en el nodo *Config*.
2. Dominio propio del Worker: `bcv-api.sisteg.net` (custom domain sobre la zona `sisteg.net`), declarado en `wrangler.toml` (`routes`, `custom_domain = true`) para que quede versionado y sea reproducible en futuros `wrangler deploy`.
3. CI (`.github/workflows/deploy.yml`) desplegado pero requiere secrets del repo en GitHub: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
4. Ver "Limitación conocida" arriba para el único punto pendiente de producción.

## Deploy manual

```bash
npm install
npx wrangler d1 create bcv_rates          # ya hecho — database_id real en wrangler.toml
npx wrangler d1 execute bcv_rates --remote --file=./schema.sql   # ya aplicado
npx wrangler secret put INGEST_TOKEN      # ya hecho
npx wrangler secret put ALERT_WEBHOOK_URL # ya hecho
npx wrangler deploy                       # ya hecho — bcv-api.sisteg.net
```

## Deploy automático (GitHub Actions)

Cada push a `main` que toque `src/`, `wrangler.toml`, `schema.sql` o `package.json` corre `wrangler d1 execute` (idempotente, `IF NOT EXISTS`) + `wrangler deploy`. Requiere los dos secrets del repo mencionados arriba.
