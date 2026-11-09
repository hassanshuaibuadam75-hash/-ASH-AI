-- #ash Mesh — Row Level Security for the TEST project.
-- Apply AFTER 0001_schema.sql.
--
-- Access model:
--   * The Node API writes with the service role key, which bypasses RLS. All authorization
--     (ownership, friendship, privacy, roles) is enforced in server/*.js before any write.
--   * These policies govern DIRECT client access (anon/authenticated key), so a leaked anon key
--     can never read another user's data. Default posture is deny.
--   * Private message envelopes are readable only by conversation members. The ciphertext is
--     useless without the recipient's device key, which never leaves the device.

alter table public.users                enable row level security;
alter table public.sessions             enable row level security;
alter table public.password_resets      enable row level security;
alter table public.media                enable row level security;
alter table public.posts                enable row level security;
alter table public.post_likes           enable row level security;
alter table public.comments             enable row level security;
alter table public.friendships          enable row level security;
alter table public.blocks               enable row level security;
alter table public.notifications        enable row level security;
alter table public.reports              enable row level security;
alter table public.conversations        enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages             enable row level security;
alter table public.marketplace_listings enable row level security;
alter table public.orders               enable row level security;
alter table public.transactions         enable row level security;
alter table public.seller_verifications enable row level security;
alter table public.audit_logs           enable row level security;
alter table public.uar_telemetry        enable row level security;
alter table public.relay_consents       enable row level security;
alter table public.ai_usage             enable row level security;

-- No policy is created for sessions, password_resets, audit_logs or transactions:
-- with RLS enabled and no policy, only the service role can touch them. That is intentional.

-- ---------------------------------------------------------------- helpers
create or replace function public.ash_current_user_id() returns text
language sql stable as $$
  -- Maps the Supabase Auth subject to the app user id. The app stores its own text ids;
  -- when Supabase Auth is used, users.id is set to the auth uid at provisioning time.
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '');
$$;

create or replace function public.ash_is_founder() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select u.is_founder from public.users u where u.id = public.ash_current_user_id()), false);
$$;

create or replace function public.ash_has_permission(perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select u.role in ('founder','admin') and (u.is_founder or u.permissions ? perm)
    from public.users u where u.id = public.ash_current_user_id()
  ), false);
$$;

create or replace function public.ash_are_friends(a text, b text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester_id = a and f.addressee_id = b) or (f.requester_id = b and f.addressee_id = a))
  );
$$;

create or replace function public.ash_is_blocked(a text, b text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.blocks bl
    where (bl.blocker_id = a and bl.blocked_id = b) or (bl.blocker_id = b and bl.blocked_id = a)
  );
$$;

create or replace function public.ash_in_conversation(conv text, uid text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.conversation_members m where m.conversation_id = conv and m.user_id = uid);
$$;

-- ---------------------------------------------------------------- users
drop policy if exists users_select_self_or_public on public.users;
create policy users_select_self_or_public on public.users
for select using (
  id = public.ash_current_user_id()
  or public.ash_is_founder()
  or public.ash_has_permission('users.view')
  or (
    coalesce((privacy ->> 'profile')::text, 'public') = 'public'
    and not public.ash_is_blocked(id, public.ash_current_user_id())
  )
);

drop policy if exists users_update_self on public.users;
create policy users_update_self on public.users
for update using (id = public.ash_current_user_id())
with check (
  id = public.ash_current_user_id()
  -- A client may never escalate its own role, founder flag or verification state.
  and role = (select role from public.users u where u.id = public.ash_current_user_id())
  and is_founder = (select is_founder from public.users u where u.id = public.ash_current_user_id())
  and is_verified_seller = (select is_verified_seller from public.users u where u.id = public.ash_current_user_id())
);

-- ---------------------------------------------------------------- media
drop policy if exists media_select_owner on public.media;
create policy media_select_owner on public.media
for select using (
  owner_id = public.ash_current_user_id()
  or public.ash_is_founder()
  or public.ash_has_permission('moderation.content')
);

drop policy if exists media_insert_own on public.media;
create policy media_insert_own on public.media
for insert with check (owner_id = public.ash_current_user_id());

drop policy if exists media_delete_own on public.media;
create policy media_delete_own on public.media
for delete using (owner_id = public.ash_current_user_id());

-- ---------------------------------------------------------------- posts
drop policy if exists posts_select_visible on public.posts;
create policy posts_select_visible on public.posts
for select using (
  deleted_at is null
  and (
    author_id = public.ash_current_user_id()
    or public.ash_is_founder()
    or public.ash_has_permission('moderation.content')
    or (
      audience = 'public'
      and not public.ash_is_blocked(author_id, public.ash_current_user_id())
    )
    or (
      audience = 'friends'
      and public.ash_are_friends(author_id, public.ash_current_user_id())
    )
  )
);

drop policy if exists posts_insert_own on public.posts;
create policy posts_insert_own on public.posts
for insert with check (author_id = public.ash_current_user_id());

drop policy if exists posts_update_own on public.posts;
create policy posts_update_own on public.posts
for update using (author_id = public.ash_current_user_id())
with check (author_id = public.ash_current_user_id());

drop policy if exists posts_delete_own_or_moderator on public.posts;
create policy posts_delete_own_or_moderator on public.posts
for delete using (
  author_id = public.ash_current_user_id() or public.ash_has_permission('moderation.content')
);

-- ---------------------------------------------------------------- likes & comments
drop policy if exists post_likes_select on public.post_likes;
create policy post_likes_select on public.post_likes
for select using (
  exists (select 1 from public.posts p where p.id = post_id)
);

drop policy if exists post_likes_insert_own on public.post_likes;
create policy post_likes_insert_own on public.post_likes
for insert with check (user_id = public.ash_current_user_id());

drop policy if exists post_likes_delete_own on public.post_likes;
create policy post_likes_delete_own on public.post_likes
for delete using (user_id = public.ash_current_user_id());

drop policy if exists comments_select_visible on public.comments;
create policy comments_select_visible on public.comments
for select using (deleted_at is null and exists (select 1 from public.posts p where p.id = post_id));

drop policy if exists comments_insert_own on public.comments;
create policy comments_insert_own on public.comments
for insert with check (author_id = public.ash_current_user_id());

drop policy if exists comments_delete_own_or_moderator on public.comments;
create policy comments_delete_own_or_moderator on public.comments
for delete using (author_id = public.ash_current_user_id() or public.ash_has_permission('moderation.content'));

-- ---------------------------------------------------------------- friendships & blocks
drop policy if exists friendships_select_participants on public.friendships;
create policy friendships_select_participants on public.friendships
for select using (
  requester_id = public.ash_current_user_id()
  or addressee_id = public.ash_current_user_id()
  or public.ash_is_founder()
);

drop policy if exists friendships_insert_requester on public.friendships;
create policy friendships_insert_requester on public.friendships
for insert with check (requester_id = public.ash_current_user_id() and status = 'pending');

-- Only the addressee may accept/reject; only the requester may cancel (delete).
drop policy if exists friendships_update_addressee on public.friendships;
create policy friendships_update_addressee on public.friendships
for update using (addressee_id = public.ash_current_user_id())
with check (addressee_id = public.ash_current_user_id() and status in ('accepted','rejected'));

drop policy if exists friendships_delete_participants on public.friendships;
create policy friendships_delete_participants on public.friendships
for delete using (requester_id = public.ash_current_user_id() or addressee_id = public.ash_current_user_id());

drop policy if exists blocks_select_own on public.blocks;
create policy blocks_select_own on public.blocks
for select using (blocker_id = public.ash_current_user_id());

drop policy if exists blocks_insert_own on public.blocks;
create policy blocks_insert_own on public.blocks
for insert with check (blocker_id = public.ash_current_user_id());

drop policy if exists blocks_delete_own on public.blocks;
create policy blocks_delete_own on public.blocks
for delete using (blocker_id = public.ash_current_user_id());

-- ---------------------------------------------------------------- notifications
drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
for select using (user_id = public.ash_current_user_id());

drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications
for update using (user_id = public.ash_current_user_id())
with check (user_id = public.ash_current_user_id());

drop policy if exists notifications_delete_own on public.notifications;
create policy notifications_delete_own on public.notifications
for delete using (user_id = public.ash_current_user_id());

-- ---------------------------------------------------------------- reports
drop policy if exists reports_insert_own on public.reports;
create policy reports_insert_own on public.reports
for insert with check (reporter_id = public.ash_current_user_id());

drop policy if exists reports_select_own_or_staff on public.reports;
create policy reports_select_own_or_staff on public.reports
for select using (
  reporter_id = public.ash_current_user_id()
  or public.ash_is_founder()
  or public.ash_has_permission('moderation.reports')
);

drop policy if exists reports_update_staff on public.reports;
create policy reports_update_staff on public.reports
for update using (public.ash_is_founder() or public.ash_has_permission('moderation.reports'))
with check (public.ash_is_founder() or public.ash_has_permission('moderation.reports'));

-- ---------------------------------------------------------------- conversations & messages
drop policy if exists conversations_select_member on public.conversations;
create policy conversations_select_member on public.conversations
for select using (public.ash_in_conversation(id, public.ash_current_user_id()));

drop policy if exists conv_members_select_member on public.conversation_members;
create policy conv_members_select_member on public.conversation_members
for select using (public.ash_in_conversation(conversation_id, public.ash_current_user_id()));

drop policy if exists conv_members_update_self on public.conversation_members;
create policy conv_members_update_self on public.conversation_members
for update using (user_id = public.ash_current_user_id())
with check (user_id = public.ash_current_user_id());

-- Members can read envelopes, but the payload stays encrypted end-to-end.
drop policy if exists messages_select_member on public.messages;
create policy messages_select_member on public.messages
for select using (public.ash_in_conversation(conversation_id, public.ash_current_user_id()));

drop policy if exists messages_insert_member on public.messages;
create policy messages_insert_member on public.messages
for insert with check (
  sender_id = public.ash_current_user_id()
  and public.ash_in_conversation(conversation_id, public.ash_current_user_id())
);

drop policy if exists messages_delete_sender on public.messages;
create policy messages_delete_sender on public.messages
for delete using (sender_id = public.ash_current_user_id());

-- ---------------------------------------------------------------- marketplace
drop policy if exists listings_select_active on public.marketplace_listings;
create policy listings_select_active on public.marketplace_listings
for select using (
  status in ('active','sold')
  or seller_id = public.ash_current_user_id()
  or public.ash_is_founder()
  or public.ash_has_permission('moderation.content')
);

drop policy if exists listings_insert_own on public.marketplace_listings;
create policy listings_insert_own on public.marketplace_listings
for insert with check (seller_id = public.ash_current_user_id());

drop policy if exists listings_update_own on public.marketplace_listings;
create policy listings_update_own on public.marketplace_listings
for update using (seller_id = public.ash_current_user_id())
with check (seller_id = public.ash_current_user_id());

drop policy if exists listings_delete_own on public.marketplace_listings;
create policy listings_delete_own on public.marketplace_listings
for delete using (seller_id = public.ash_current_user_id());

drop policy if exists orders_select_participant on public.orders;
create policy orders_select_participant on public.orders
for select using (
  buyer_id = public.ash_current_user_id()
  or seller_id = public.ash_current_user_id()
  or public.ash_is_founder()
  or public.ash_has_permission('market.orders')
);

-- Clients may create an order only for themselves; commission fields are computed server-side,
-- and the check below refuses a client that tries to zero out the platform commission.
drop policy if exists orders_insert_buyer on public.orders;
create policy orders_insert_buyer on public.orders
for insert with check (
  buyer_id = public.ash_current_user_id()
  and buyer_id <> seller_id
  and commission_minor + payout_minor = amount_minor
  and commission_minor > 0
);

drop policy if exists verifications_select_own_or_staff on public.seller_verifications;
create policy verifications_select_own_or_staff on public.seller_verifications
for select using (
  user_id = public.ash_current_user_id()
  or public.ash_is_founder()
  or public.ash_has_permission('market.verify')
);

drop policy if exists verifications_insert_own on public.seller_verifications;
create policy verifications_insert_own on public.seller_verifications
for insert with check (user_id = public.ash_current_user_id() and status = 'pending');

drop policy if exists verifications_review_staff on public.seller_verifications;
create policy verifications_review_staff on public.seller_verifications
for update using (public.ash_is_founder() or public.ash_has_permission('market.verify'))
with check (public.ash_is_founder() or public.ash_has_permission('market.verify'));

-- ---------------------------------------------------------------- telemetry & consent
drop policy if exists uar_insert_own on public.uar_telemetry;
create policy uar_insert_own on public.uar_telemetry
for insert with check (user_id = public.ash_current_user_id());

drop policy if exists uar_select_own_or_staff on public.uar_telemetry;
create policy uar_select_own_or_staff on public.uar_telemetry
for select using (user_id = public.ash_current_user_id() or public.ash_is_founder());

drop policy if exists relay_consent_select_own on public.relay_consents;
create policy relay_consent_select_own on public.relay_consents
for select using (user_id = public.ash_current_user_id());

drop policy if exists relay_consent_upsert_own on public.relay_consents;
create policy relay_consent_upsert_own on public.relay_consents
for insert with check (user_id = public.ash_current_user_id());

drop policy if exists relay_consent_update_own on public.relay_consents;
create policy relay_consent_update_own on public.relay_consents
for update using (user_id = public.ash_current_user_id())
with check (user_id = public.ash_current_user_id());

drop policy if exists ai_usage_select_own on public.ai_usage;
create policy ai_usage_select_own on public.ai_usage
for select using (user_id = public.ash_current_user_id() or public.ash_is_founder());

drop policy if exists ai_usage_insert_own on public.ai_usage;
create policy ai_usage_insert_own on public.ai_usage
for insert with check (user_id = public.ash_current_user_id());
