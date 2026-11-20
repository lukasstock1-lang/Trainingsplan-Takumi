-- Takumi 74: Datenbank-Schema
CREATE TABLE trainers (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

-- Wöchentlich wiederkehrende Trainings (weekday: 1 = Montag … 7 = Sonntag)
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  weekday     INTEGER NOT NULL,
  title       TEXT NOT NULL,
  audience    TEXT NOT NULL,
  start_time  TEXT,
  end_time    TEXT,
  time_text   TEXT,
  location    TEXT NOT NULL,
  trainer_ids TEXT NOT NULL DEFAULT '[]',
  sort        INTEGER NOT NULL DEFAULT 0
);

-- Ausnahmen für einen Termin: "<sessionId>@<YYYY-MM-DD>"
CREATE TABLE exceptions (
  key         TEXT PRIMARY KEY,
  canceled    INTEGER NOT NULL DEFAULT 0,
  reason      TEXT,
  canceled_at TEXT,
  trainer_ids TEXT
);

-- Protokoll der Absagen (daraus entstehen die Hinweise in der App)
CREATE TABLE events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  type   TEXT NOT NULL,
  key    TEXT NOT NULL,
  reason TEXT,
  at     TEXT NOT NULL,
  origin TEXT
);

-- Geräte, die Push-Nachrichten bekommen
CREATE TABLE subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  groups     TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE login_attempts (
  ip           TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
