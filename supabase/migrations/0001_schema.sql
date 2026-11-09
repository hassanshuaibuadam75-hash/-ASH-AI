-- #ash Mesh — Supabase schema for the TEST project only.
-- TEST project ref: wfnhlrwqwpiuqaamdbvz  (https://wfnhlrwqwpiuqaamdbvz.supabase.co)
-- NEVER run this against the LIVE project (zwfleqgmamohxxzjwkaf) without explicit authorization.
--
-- This mirrors server/schema.sql one-for-one: same table names, same columns, same semantics.
-- The Node API is the only writer and connects with the service role key (kept server-side).
-- Row Level Security is enabled in 0002_rls.sql so that any direct client (anon) access is
-- denied by default and only ever exposes rows the caller is allowed to read.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- accounts
create table if not exists public.users (
  id                 text primary key,
  email              text not null unique,
  username           text not null unique,
  password_hash      text not null,
  full_name          text not null,
  bio                text not null default '',
  phone              text not null default '',
  country            text not null default '',
  state              text not null default '',
  city               text not null default '',
  home_address       text not null default '',
  occupation         text not null default '',
  education          text not null default '',
  skills             text not null default '',
  interests          text not null default '',
  website            text not null default '',
  social_links       jsonb not null default '{}'::jsonb,
  language           text not null default 'en',
  avatar_media_id    text,
  cover_media_id     text,
  role               text not null default 'member'
                     check (role in ('member','moderator','admin','founder')),
  permissions        jsonb not null default '[]'::jsonb,
  is_founder         boolean not null default false,
  public_key_jwk     jsonb,
  is_verified_seller boolean not null default false,
  status             text not null default 'active'
                     check (status in ('active','restricted','suspended')),
  privacy            jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  last_seen_at       timestamptz
);
create index if not exists idx_users_username on public.users (username);
create index if not exists idx_users_email on public.users (email);

-- Only one Founder account may ever exist, and the flag can never be granted by a client.
create unique index if not exists uniq_single_founder on public.users ((is_founder)) where is_founder;

create table if not exists public.sessions (
  id         text primary key,
  user_id    text not null references public.users(id) on delete cascade,
  token_hash text not null unique,
  csrf_token text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip         text not null default '',
  user_agent text not null default ''
);
create index if not exists idx_sessions_user on public.sessions (user_id);

create table if not exists public.password_resets (
  id         text primary key,
  user_id    text not null references public.users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- media
create table if not exists public.media (
  id         text primary key,
  owner_id   text not null references public.users(id) on delete cascade,
  kind       text not null check (kind in ('image','video','audio','file','model')),
  mime       text not null,
  size       bigint not null,
  path       text not null,
  sha256     text not null default '',
  encrypted  boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_media_owner on public.media (owner_id);

-- ---------------------------------------------------------------- social
create table if not exists public.posts (
  id             text primary key,
  author_id      text not null references public.users(id) on delete cascade,
  body           text not null default '',
  kind           text not null default 'text' check (kind in ('text','image','video','model','file')),
  audience       text not null default 'public' check (audience in ('public','friends','private')),
  media_id       text references public.media(id) on delete set null,
  shared_post_id text references public.posts(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);
create index if not exists idx_posts_author on public.posts (author_id, created_at desc);
create index if not exists idx_posts_created on public.posts (created_at desc);

create table if not exists public.post_likes (
  post_id    text not null references public.posts(id) on delete cascade,
  user_id    text not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists public.comments (
  id         text primary key,
  post_id    text not null references public.posts(id) on delete cascade,
  author_id  text not null references public.users(id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists idx_comments_post on public.comments (post_id, created_at);

create table if not exists public.friendships (
  id           text primary key,
  requester_id text not null references public.users(id) on delete cascade,
  addressee_id text not null references public.users(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending','accepted','rejected')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);
create index if not exists idx_friend_addressee on public.friendships (addressee_id, status);
create index if not exists idx_friend_requester on public.friendships (requester_id, status);

create table if not exists public.blocks (
  blocker_id text not null references public.users(id) on delete cascade,
  blocked_id text not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create table if not exists public.notifications (
  id          text primary key,
  user_id     text not null references public.users(id) on delete cascade,
  type        text not null,
  actor_id    text references public.users(id) on delete cascade,
  entity_type text not null default '',
  entity_id   text not null default '',
  data        jsonb not null default '{}'::jsonb,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists idx_notifications_user on public.notifications (user_id, created_at desc);

create table if not exists public.reports (
  id              text primary key,
  reporter_id     text not null references public.users(id) on delete cascade,
  target_type     text not null check (target_type in ('post','comment','user','listing','message')),
  target_id       text not null,
  reason          text not null,
  details         text not null default '',
  status          text not null default 'open' check (status in ('open','reviewing','resolved','dismissed')),
  resolved_by     text references public.users(id) on delete set null,
  resolution_note text not null default '',
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz
);
create index if not exists idx_reports_status on public.reports (status, created_at desc);

-- ---------------------------------------------------------------- messaging
-- Messages store only the client-side AES-GCM envelope. The server never has the key.
create table if not exists public.conversations (
  id              text primary key,
  kind            text not null default 'direct',
  created_at      timestamptz not null default now(),
  last_message_at timestamptz
);

create table if not exists public.conversation_members (
  conversation_id text not null references public.conversations(id) on delete cascade,
  user_id         text not null references public.users(id) on delete cascade,
  joined_at       timestamptz not null default now(),
  last_read_at    timestamptz,
  primary key (conversation_id, user_id)
);
create index if not exists idx_conv_members_user on public.conversation_members (user_id);

create table if not exists public.messages (
  id              text primary key,
  conversation_id text not null references public.conversations(id) on delete cascade,
  sender_id       text not null references public.users(id) on delete cascade,
  client_id       text not null,
  kind            text not null default 'text' check (kind in ('text','image','video','audio','file')),
  envelope        jsonb not null,
  media_id        text references public.media(id) on delete set null,
  status          text not null default 'sent' check (status in ('sent','delivered','read')),
  transport       text not null default 'internet' check (transport in ('internet','nearby','queued')),
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz,
  read_at         timestamptz,
  unique (sender_id, client_id)
);
create index if not exists idx_messages_conv on public.messages (conversation_id, created_at);

-- ---------------------------------------------------------------- marketplace
create table if not exists public.marketplace_listings (
  id          text primary key,
  seller_id   text not null references public.users(id) on delete cascade,
  title       text not null,
  description text not null default '',
  category    text not null default 'general',
  price_minor bigint not null check (price_minor > 0),
  currency    text not null default 'NGN',
  location    text not null default '',
  media       jsonb not null default '[]'::jsonb,
  status      text not null default 'active' check (status in ('active','sold','removed','draft')),
  views       integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_listings_seller on public.marketplace_listings (seller_id, created_at desc);
create index if not exists idx_listings_status on public.marketplace_listings (status, created_at desc);

create table if not exists public.orders (
  id               text primary key,
  listing_id       text not null references public.marketplace_listings(id) on delete restrict,
  buyer_id         text not null references public.users(id) on delete cascade,
  seller_id        text not null references public.users(id) on delete cascade,
  amount_minor     bigint not null check (amount_minor > 0),
  commission_minor bigint not null check (commission_minor >= 0),
  commission_rate  numeric(6,5) not null check (commission_rate >= 0 and commission_rate <= 1),
  payout_minor     bigint not null check (payout_minor >= 0),
  currency         text not null default 'NGN',
  status           text not null default 'pending_payment'
                   check (status in ('pending_payment','paid','shipped','completed','cancelled','refunded','disputed')),
  provider         text not null default 'paystack',
  provider_ref     text,
  delivery_note    text not null default '',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (commission_minor + payout_minor = amount_minor)
);
create index if not exists idx_orders_buyer on public.orders (buyer_id, created_at desc);
create index if not exists idx_orders_seller on public.orders (seller_id, created_at desc);

create table if not exists public.transactions (
  id               text primary key,
  order_id         text not null references public.orders(id) on delete cascade,
  provider         text not null,
  provider_ref     text not null default '',
  amount_minor     bigint not null,
  commission_minor bigint not null,
  status           text not null check (status in ('initialized','success','failed','refunded')),
  raw              jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists idx_tx_order on public.transactions (order_id);

create table if not exists public.seller_verifications (
  id            text primary key,
  user_id       text not null references public.users(id) on delete cascade,
  business_name text not null,
  id_type       text not null,
  id_number     text not null,
  doc_media_id  text references public.media(id) on delete set null,
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by   text references public.users(id) on delete set null,
  review_note   text not null default '',
  created_at    timestamptz not null default now(),
  reviewed_at   timestamptz
);
create index if not exists idx_verif_status on public.seller_verifications (status, created_at desc);

-- ---------------------------------------------------------------- governance & telemetry
create table if not exists public.audit_logs (
  id          text primary key,
  actor_id    text references public.users(id) on delete set null,
  action      text not null,
  target_type text not null default '',
  target_id   text not null default '',
  meta        jsonb not null default '{}'::jsonb,
  ip          text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists idx_audit_created on public.audit_logs (created_at desc);

create table if not exists public.uar_telemetry (
  id         text primary key,
  user_id    text not null references public.users(id) on delete cascade,
  transport  text not null,
  battery    integer check (battery is null or (battery >= 0 and battery <= 100)),
  available  jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_uar_created on public.uar_telemetry (created_at desc);

create table if not exists public.relay_consents (
  user_id           text primary key references public.users(id) on delete cascade,
  enabled           boolean not null default false,
  allow_cellular    boolean not null default false,
  max_battery_drain integer not null default 20,
  updated_at        timestamptz not null default now()
);

create table if not exists public.ai_usage (
  id         text primary key,
  user_id    text not null references public.users(id) on delete cascade,
  feature    text not null,
  ok         boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_ai_usage_user on public.ai_usage (user_id, created_at desc);

-- ---------------------------------------------------------------- storage bucket
-- Chat attachments are stored as ciphertext blobs; only the API (service role) reads them.
insert into storage.buckets (id, name, public, file_size_limit)
values ('ashmesh-media', 'ashmesh-media', false, 52428800)
on conflict (id) do nothing;
