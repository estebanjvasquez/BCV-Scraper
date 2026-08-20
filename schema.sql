CREATE TABLE exchange_rates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  currency    TEXT NOT NULL,
  rate        REAL NOT NULL,
  value_date  TEXT NOT NULL,
  scraped_at  TEXT NOT NULL,
  UNIQUE(currency, value_date)
);
CREATE INDEX idx_rates_lookup ON exchange_rates(currency, value_date DESC);

CREATE TABLE scrape_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at      TEXT NOT NULL,
  status      TEXT NOT NULL,
  detail      TEXT,
  http_status INTEGER
);
