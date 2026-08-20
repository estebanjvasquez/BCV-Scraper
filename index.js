const VALID_CURRENCIES = new Set(['USD', 'EUR', 'CNY', 'TRY', 'RUB']);
const MAX_DAILY_DELTA_PCT = 0.15;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

async function handleIngest(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (auth !== `Bearer ${env.INGEST_TOKEN}`) return json({ error: 'unauthorized' }, 401);

  const body = await request.json();
  const { valueDate, scrapedAt, rates } = body;
  if (!valueDate || !rates) return json({ error: 'payload invalido' }, 400);

  const results = [];
  for (const [currency, rate] of Object.entries(rates)) {
    if (!VALID_CURRENCIES.has(currency)) continue;

    const prev = await env.DB.prepare(
      `SELECT rate FROM exchange_rates WHERE currency = ? ORDER BY value_date DESC LIMIT 1`
    ).bind(currency).first();

    if (prev) {
      const delta = Math.abs(rate - prev.rate) / prev.rate;
      if (delta > MAX_DAILY_DELTA_PCT) {
        await env.DB.prepare(
          `INSERT INTO scrape_log (run_at, status, detail) VALUES (?, 'rejected_anomaly', ?)`
        ).bind(new Date().toISOString(), `${currency}: ${prev.rate} -> ${rate} (${(delta * 100).toFixed(1)}%)`).run();
        results.push({ currency, status: 'rejected_anomaly' });
        continue;
      }
    }

    await env.DB.prepare(
      `INSERT INTO exchange_rates (currency, rate, value_date, scraped_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(currency, value_date) DO UPDATE SET rate = excluded.rate, scraped_at = excluded.scraped_at`
    ).bind(currency, rate, valueDate, scrapedAt || new Date().toISOString()).run();
    results.push({ currency, status: 'ok' });
  }

  await env.DB.prepare(
    `INSERT INTO scrape_log (run_at, status, detail) VALUES (?, 'success', ?)`
  ).bind(new Date().toISOString(), JSON.stringify(results)).run();

  return json({ ok: true, results });
}

async function handleLatest(request, env, currency) {
  const query = currency
    ? env.DB.prepare(`SELECT * FROM exchange_rates WHERE currency = ? ORDER BY value_date DESC LIMIT 1`).bind(currency)
    : env.DB.prepare(`
        SELECT * FROM exchange_rates
        WHERE value_date = (SELECT MAX(value_date) FROM exchange_rates)
      `);
  const { results } = await query.all();
  if (!results.length) return json({ error: 'sin datos' }, 404);
  return json(currency ? results[0] : results);
}

async function handleHistory(request, env, currency, limit) {
  const { results } = await env.DB.prepare(
    `SELECT currency, rate, value_date FROM exchange_rates WHERE currency = ? ORDER BY value_date DESC LIMIT ?`
  ).bind(currency, limit).all();
  return json(results);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    if (request.method === 'POST' && parts[0] === 'ingest') return handleIngest(request, env);

    if (request.method === 'GET' && parts[0] === 'rates') {
      if (parts[1] === 'latest') return handleLatest(request, env, parts[2]?.toUpperCase());
      if (parts[1] === 'history') {
        const currency = url.searchParams.get('currency')?.toUpperCase();
        const limit = parseInt(url.searchParams.get('limit') || '30', 10);
        if (!currency || !VALID_CURRENCIES.has(currency)) return json({ error: 'currency invalida' }, 400);
        return handleHistory(request, env, currency, limit);
      }
    }

    if (parts[0] === 'health') return json({ ok: true });

    return json({ error: 'not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    const today = new Date().toISOString().slice(0, 10);
    const row = await env.DB.prepare(
      `SELECT 1 FROM exchange_rates WHERE currency='USD' AND value_date >= ?`
    ).bind(today).first();
    if (!row && env.ALERT_WEBHOOK_URL) {
      await fetch(env.ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `BCV: sin tasa nueva hoy ${today}` }),
      });
    }
  },
};
