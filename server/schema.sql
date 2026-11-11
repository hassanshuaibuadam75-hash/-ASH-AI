-- #ash Mesh relational schema (SQLite / production mirror of supabase/migrations)
-- Every table below is used by real API endpoints. No sample rows are inserted.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,
  username          TEXT NOT NULL UNIQUE,
  password_hash     TEXT NOT NULL,
  full_name         TEXT NOT NULL,
  bio               TEXT NOT NULL DEFAULT '',
  phone             TEXT NOT NULL DEFAULT '',
  country           TEXT NOT NULL DEFAULT '',
  state             TEXT NOT NULL DEFAULT '',
  city              TEXT NOT NULL DEFAULT '',
  home_address      TEXT NOT NULL DEFAULT '',
  occupation        TEXT NOT NULL DEFAULT '',
  education         TEXT NOT NULL DEFAULT '',
  skills            TEXT NOT NULL DEFAULT '',
  interests         TEXT NOT NULL DEFAULT '',
  website           TEXT NOT NULL DEFAULT '',
  social_links      TEXT NOT NULL DEFAULT '{}',
  language          TEXT NOT NULL DEFAULT 'en',
  avatar_media_id   TEXT,
  cover_media_id    TEXT,
  role              TEXT NOT NULL DEFAULT 'member',      -- member | moderator | admin | founder
  permissions       TEXT NOT NULL DEFAULT '[]',           -- explicit admin grants (JSON array)
  is_founder        INTEGER NOT NULL DEFAULT 0,           -- immutable, single account
  public_key_jwk    TEXT,                                 -- X25519/ECDH public key for E2E messaging
  is_verified_seller INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'active',       -- active | restricted | suspended
  privacy           TEXT NOT NULL DEFAULT '{}',           -- JSON privacy settings
  created_at        TEXT NOT NULL,
  last_seen_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  csrf_token  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  ip          TEXT NOT NULL DEFAULT '',
  user_agent  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS password_resets (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                -- image | video | audio | file | model
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  path        TEXT NOT NULL,
  sha256      TEXT NOT NULL DEFAULT '',
  encrypted   INTEGER NOT NULL DEFAULT 0,   -- 1 = ciphertext blob (E2E chat attachments)
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_owner ON media(owner_id);

CREATE TABLE IF NOT EXISTS posts (
  id             TEXT PRIMARY KEY,
  author_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body           TEXT NOT NULL DEFAULT '',
  kind           TEXT NOT NULL DEFAULT 'text',  -- text | image | video | model | file
  audience       TEXT NOT NULL DEFAULT 'public',-- public | friends | private
  media_id       TEXT REFERENCES media(id) ON DELETE SET NULL,
  shared_post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
  client_id      TEXT,                          -- device-generated id for offline replay
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);

CREATE TABLE IF NOT EXISTS post_likes (
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);

CREATE TABLE IF NOT EXISTS friendships (
  id           TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (requester_id, addressee_id)
);
CREATE INDEX IF NOT EXISTS idx_friend_addressee ON friendships(addressee_id, status);
CREATE INDEX IF NOT EXISTS idx_friend_requester ON friendships(requester_id, status);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  actor_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id   TEXT NOT NULL DEFAULT '',
  data        TEXT NOT NULL DEFAULT '{}',
  read_at     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reports (
  id             TEXT PRIMARY KEY,
  reporter_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type    TEXT NOT NULL,   -- post | comment | user | listing | message
  target_id      TEXT NOT NULL,
  reason         TEXT NOT NULL,
  details        TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'open', -- open | reviewing | resolved | dismissed
  resolved_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolution_note TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  resolved_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);

CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL DEFAULT 'direct',
  created_at      TEXT NOT NULL,
  last_message_at TEXT
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at       TEXT NOT NULL,
  last_read_at    TEXT,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conversation_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id       TEXT NOT NULL,          -- client-generated idempotency key (offline queue)
  kind            TEXT NOT NULL DEFAULT 'text', -- text | image | video | audio | file
  envelope        TEXT NOT NULL,          -- JSON AES-GCM envelope; server never sees plaintext
  media_id        TEXT REFERENCES media(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'sent', -- sent | delivered | read
  transport       TEXT NOT NULL DEFAULT 'internet', -- internet | nearby | queued
  created_at      TEXT NOT NULL,
  delivered_at    TEXT,
  read_at         TEXT,
  UNIQUE (sender_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS marketplace_listings (
  id           TEXT PRIMARY KEY,
  seller_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT 'general',
  price_minor  INTEGER NOT NULL,          -- kobo
  currency     TEXT NOT NULL DEFAULT 'NGN',
  location     TEXT NOT NULL DEFAULT '',
  media        TEXT NOT NULL DEFAULT '[]',-- JSON array of media ids
  status       TEXT NOT NULL DEFAULT 'active', -- active | sold | removed | draft
  views        INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listings_seller ON marketplace_listings(seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_listings_status ON marketplace_listings(status, created_at DESC);

CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT PRIMARY KEY,
  listing_id         TEXT NOT NULL REFERENCES marketplace_listings(id) ON DELETE RESTRICT,
  buyer_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_minor       INTEGER NOT NULL,
  commission_minor   INTEGER NOT NULL,
  commission_rate    REAL NOT NULL,
  payout_minor       INTEGER NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'NGN',
  status             TEXT NOT NULL DEFAULT 'pending_payment', -- pending_payment | held_founder_review | paid | shipped | completed | cancelled | refunded | rejected
  provider           TEXT NOT NULL DEFAULT 'paystack',
  provider_ref       TEXT,
  delivery_note      TEXT NOT NULL DEFAULT '',
  idempotency_key    TEXT,                 -- client-generated key: one order per key per buyer
  review_note        TEXT NOT NULL DEFAULT '',
  reviewed_by        TEXT,
  reviewed_at        TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency ON orders(buyer_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id, created_at DESC);

CREATE TABLE IF NOT EXISTS transactions (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  provider_ref    TEXT NOT NULL DEFAULT '',
  amount_minor    INTEGER NOT NULL,
  commission_minor INTEGER NOT NULL,
  status          TEXT NOT NULL,          -- initialized | success | failed | refunded
  raw             TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_order ON transactions(order_id);

CREATE TABLE IF NOT EXISTS seller_verifications (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  id_type       TEXT NOT NULL,
  id_number     TEXT NOT NULL,
  doc_media_id  TEXT REFERENCES media(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  reviewed_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  review_note   TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  reviewed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_verif_status ON seller_verifications(status, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id   TEXT NOT NULL DEFAULT '',
  meta        TEXT NOT NULL DEFAULT '{}',
  ip          TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS uar_telemetry (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transport  TEXT NOT NULL,             -- internet | nearby | wifi_aware | wifi_direct | ble | lora | queued
  battery    INTEGER,
  available  TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uar_created ON uar_telemetry(created_at DESC);

CREATE TABLE IF NOT EXISTS relay_consents (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled    INTEGER NOT NULL DEFAULT 0,
  allow_cellular INTEGER NOT NULL DEFAULT 0,
  max_battery_drain INTEGER NOT NULL DEFAULT 20,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature    TEXT NOT NULL,
  ok         INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rate_events (
  key        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_key ON rate_events(key, created_at);


-- ============================ Offline-first support ============================
-- A post may be created while the device is offline. The client sends a stable
-- client_id, so replaying the outbox can never create a duplicate post.
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_client ON posts(author_id, client_id)
  WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_updated ON posts(updated_at DESC);

-- ============================== #ash Academy ==================================
CREATE TABLE IF NOT EXISTS academy_courses (
  id             TEXT PRIMARY KEY,
  author_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  summary        TEXT NOT NULL DEFAULT '',
  category       TEXT NOT NULL DEFAULT 'general',
  language       TEXT NOT NULL DEFAULT 'en',
  level          TEXT NOT NULL DEFAULT 'beginner',   -- beginner | intermediate | advanced
  cover_media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  published      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_academy_updated ON academy_courses(updated_at DESC);

CREATE TABLE IF NOT EXISTS academy_lessons (
  id               TEXT PRIMARY KEY,
  course_id        TEXT NOT NULL REFERENCES academy_courses(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL DEFAULT 0,
  title            TEXT NOT NULL,
  body             TEXT NOT NULL DEFAULT '',
  media_id         TEXT REFERENCES media(id) ON DELETE SET NULL,
  duration_minutes INTEGER,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_lessons_course ON academy_lessons(course_id, position);

CREATE TABLE IF NOT EXISTS academy_enrollments (
  course_id           TEXT NOT NULL REFERENCES academy_courses(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  completed_lesson_ids TEXT NOT NULL DEFAULT '[]',
  progress            INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (course_id, user_id)
);

-- ============================== #ash Heritage =================================
CREATE TABLE IF NOT EXISTS heritage_entries (
  id         TEXT PRIMARY KEY,
  author_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  category   TEXT NOT NULL DEFAULT 'story',  -- story | language | craft | music | history | recipe
  region     TEXT,
  country    TEXT,
  language   TEXT,
  media_id   TEXT REFERENCES media(id) ON DELETE SET NULL,
  published  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_heritage_updated ON heritage_entries(updated_at DESC);

CREATE TABLE IF NOT EXISTS heritage_reactions (
  entry_id   TEXT NOT NULL REFERENCES heritage_entries(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'respect',
  created_at TEXT NOT NULL,
  PRIMARY KEY (entry_id, user_id, kind)
);
