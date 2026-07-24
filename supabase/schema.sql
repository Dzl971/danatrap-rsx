-- DanaTrap RSX V4 — Schéma Supabase complet
-- À coller dans Supabase > SQL Editor > New query > Run.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique not null references auth.users(id) on delete cascade,
  slug text unique not null,
  name text not null,
  username text not null,
  role text not null default 'Artiste' check (role in ('Admin','Beatmaker','Artiste','Producteur','Ingénieur du son','Manager')),
  initials text,
  bio text default '',
  location text default '',
  followers bigint default 0,
  plays bigint default 0,
  verified boolean default false,
  avatar text default '',
  banner text default '',
  socials jsonb not null default '{}'::jsonb,
  theme jsonb not null default '{"accent":"#f6c90e","secondary":"#7c5cff","background":"#111217","profileEffect":"particles","frameStyle":"glass","buttonStyle":"pill","cardRadius":24,"cardBorder":"rgba(255,255,255,.13)"}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.beats (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  producer_id uuid not null references public.profiles(user_id) on delete cascade,
  producer_slug text not null default '',
  producer_name text not null default '',
  title text not null,
  bpm integer not null default 140,
  key text not null default 'C min',
  genre text not null default 'Trap',
  mood text default '',
  description text default '',
  tags jsonb not null default '[]'::jsonb,
  visibility text not null default 'Brouillon' check (visibility in ('Brouillon','Publié','Réservé','Expiré')),
  plays bigint not null default 0,
  likes bigint not null default 0,
  duration text default '0:00',
  audio text default '',
  cover_image text default '',
  cover_class text default 'cover-a',
  files jsonb not null default '[]'::jsonb,
  design jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.licenses (
  id uuid primary key default gen_random_uuid(),
  beat_id uuid not null references public.beats(id) on delete cascade,
  name text not null,
  price numeric(12,2),
  description text default '',
  terms text default '',
  active boolean not null default true,
  custom boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'Conversation',
  beat_id uuid references public.beats(id) on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (conversation_id,user_id)
);
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(user_id) on delete cascade,
  type text not null default 'text' check (type in ('text','reservation','system','file')),
  text text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  beat_id uuid not null references public.beats(id) on delete cascade,
  artist_id uuid not null references public.profiles(user_id) on delete cascade,
  beatmaker_id uuid not null references public.profiles(user_id) on delete cascade,
  license_name text not null,
  status text not null default 'En discussion' check (status in ('En discussion','Acceptée','Refusée','Annulée','Terminée')),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  type text not null default 'message',
  title text not null,
  body text default '',
  link text default '#/app',
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(user_id) on delete cascade,
  author text not null,
  title text not null,
  details text not null,
  budget text default '',
  deadline text default '',
  created_at timestamptz not null default now()
);

create table if not exists public.collaboration_projects (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  beat_id uuid references public.beats(id) on delete set null,
  status text not null default 'À écouter',
  progress integer not null default 0 check (progress between 0 and 100),
  deadline text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.collaboration_members (
  project_id uuid not null references public.collaboration_projects(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  primary key(project_id,user_id)
);
create table if not exists public.collaboration_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.collaboration_projects(id) on delete cascade,
  name text not null,
  version integer not null default 1,
  kind text default 'file',
  size text default '',
  drive_id text default '',
  stream_url text default '',
  created_at timestamptz not null default now()
);
create table if not exists public.collaboration_comments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.collaboration_projects(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  timecode text default '',
  text text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.collaboration_credits (
  project_id uuid not null references public.collaboration_projects(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  role text not null,
  share numeric(5,2) not null default 0,
  primary key(project_id,user_id)
);

create table if not exists public.favorites (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  beat_id uuid not null references public.beats(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id,beat_id)
);
create table if not exists public.playlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.playlist_items (
  playlist_id uuid not null references public.playlists(id) on delete cascade,
  beat_id uuid not null references public.beats(id) on delete cascade,
  sort_order integer not null default 0,
  primary key (playlist_id,beat_id)
);

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from public.profiles where user_id=auth.uid() and role='Admin'); $$;

create or replace function public.is_conversation_member(p_conversation uuid)
returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from public.conversation_members where conversation_id=p_conversation and user_id=auth.uid()); $$;


create or replace function public.is_collaboration_member(p_project uuid)
returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from public.collaboration_members where project_id=p_project and user_id=auth.uid()); $$;

create or replace function public.make_slug(input text)
returns text language sql immutable
as $$ select trim(both '-' from regexp_replace(lower(coalesce(input,'user')), '[^a-z0-9]+', '-', 'g')); $$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path=public
as $$
declare
  v_name text := coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1));
  v_role text := coalesce(new.raw_user_meta_data->>'role','Artiste');
  v_slug text;
begin
  if v_role not in ('Admin','Beatmaker','Artiste','Producteur','Ingénieur du son','Manager') then v_role := 'Artiste'; end if;
  v_slug := public.make_slug(v_name)||'-'||substr(new.id::text,1,5);
  insert into public.profiles(user_id,slug,name,username,role,initials)
  values(new.id,v_slug,v_name,'@'||replace(public.make_slug(v_name),'-',''),v_role,upper(substr(v_name,1,2)));
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end; $$;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger beats_touch before update on public.beats for each row execute function public.touch_updated_at();
create trigger reservations_touch before update on public.reservations for each row execute function public.touch_updated_at();

create or replace function public.touch_conversation()
returns trigger language plpgsql security definer set search_path=public
as $$ begin update public.conversations set updated_at=now() where id=new.conversation_id; return new; end; $$;
create trigger message_touches_conversation after insert on public.messages for each row execute function public.touch_conversation();

-- Réservation atomique : conversation + bloc message + notification + statut Réservé.
create or replace function public.reserve_beat(p_beat_id uuid,p_license_name text,p_note text default '')
returns jsonb language plpgsql security definer set search_path=public
as $$
declare
  v_beat public.beats%rowtype;
  v_artist public.profiles%rowtype;
  v_conv uuid;
  v_res uuid;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  select * into v_beat from public.beats where id=p_beat_id for update;
  if not found then raise exception 'Production introuvable'; end if;
  if v_beat.visibility='Expiré' then raise exception 'Cette production est expirée'; end if;
  if v_beat.producer_id=auth.uid() then raise exception 'Tu ne peux pas réserver ta propre production'; end if;
  select * into v_artist from public.profiles where user_id=auth.uid();
  insert into public.conversations(title,beat_id) values(v_artist.name||' · '||v_beat.title,p_beat_id) returning id into v_conv;
  insert into public.conversation_members(conversation_id,user_id) values(v_conv,auth.uid()),(v_conv,v_beat.producer_id);
  insert into public.reservations(beat_id,artist_id,beatmaker_id,license_name,conversation_id)
  values(p_beat_id,auth.uid(),v_beat.producer_id,p_license_name,v_conv) returning id into v_res;
  insert into public.messages(conversation_id,sender_id,type,text,payload)
  values(v_conv,auth.uid(),'reservation','Réservation envoyée',jsonb_build_object('beat_id',p_beat_id,'license_name',p_license_name,'status','En discussion','note',coalesce(p_note,'')));
  if length(trim(coalesce(p_note,'')))>0 then insert into public.messages(conversation_id,sender_id,type,text) values(v_conv,auth.uid(),'text',p_note); end if;
  insert into public.notifications(user_id,type,title,body,link)
  values(v_beat.producer_id,'reservation',v_beat.title||' a été réservée',v_artist.name||' a choisi la licence '||p_license_name,'#/app/messages/'||v_conv::text);
  update public.beats set visibility='Réservé' where id=p_beat_id and visibility<>'Expiré';
  return jsonb_build_object('reservation_id',v_res,'conversation_id',v_conv,'conversation',jsonb_build_object('id',v_conv));
end; $$;

-- Vue volontairement limitée pour l'interface admin.
create or replace view public.admin_users as
select p.user_id as id,p.name,p.role,p.initials,p.created_at,null::text as email from public.profiles p;

alter table public.profiles enable row level security;
alter table public.beats enable row level security;
alter table public.licenses enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.reservations enable row level security;
alter table public.notifications enable row level security;
alter table public.announcements enable row level security;
alter table public.collaboration_projects enable row level security;
alter table public.collaboration_members enable row level security;
alter table public.collaboration_files enable row level security;
alter table public.collaboration_comments enable row level security;
alter table public.collaboration_credits enable row level security;
alter table public.favorites enable row level security;
alter table public.playlists enable row level security;
alter table public.playlist_items enable row level security;

create policy profiles_public_read on public.profiles for select using (true);
create policy profiles_self_update on public.profiles for update using (user_id=auth.uid() or public.is_admin()) with check (user_id=auth.uid() or public.is_admin());
create policy beats_read on public.beats for select using (visibility<>'Brouillon' or producer_id=auth.uid() or public.is_admin());
create policy beats_insert on public.beats for insert with check (producer_id=auth.uid() or public.is_admin());
create policy beats_update on public.beats for update using (producer_id=auth.uid() or public.is_admin()) with check (producer_id=auth.uid() or public.is_admin());
create policy beats_delete on public.beats for delete using (producer_id=auth.uid() or public.is_admin());
create policy licenses_read on public.licenses for select using (true);
create policy licenses_manage on public.licenses for all using (exists(select 1 from public.beats b where b.id=beat_id and (b.producer_id=auth.uid() or public.is_admin()))) with check (exists(select 1 from public.beats b where b.id=beat_id and (b.producer_id=auth.uid() or public.is_admin())));
create policy conversations_read on public.conversations for select using (public.is_admin() or public.is_conversation_member(id));
create policy conversation_members_read on public.conversation_members for select using (public.is_admin() or user_id=auth.uid() or public.is_conversation_member(conversation_id));
create policy messages_read on public.messages for select using (public.is_admin() or public.is_conversation_member(conversation_id));
create policy messages_insert on public.messages for insert with check (sender_id=auth.uid() and public.is_conversation_member(conversation_id));
create policy reservations_read on public.reservations for select using (public.is_admin() or artist_id=auth.uid() or beatmaker_id=auth.uid());
create policy reservations_update on public.reservations for update using (public.is_admin() or artist_id=auth.uid() or beatmaker_id=auth.uid());
create policy notifications_read on public.notifications for select using (user_id=auth.uid() or public.is_admin());
create policy notifications_update on public.notifications for update using (user_id=auth.uid() or public.is_admin());
create policy announcements_read on public.announcements for select using (true);
create policy announcements_insert on public.announcements for insert with check (author_id=auth.uid());
create policy announcements_manage on public.announcements for update using (author_id=auth.uid() or public.is_admin());
create policy announcements_delete on public.announcements for delete using (author_id=auth.uid() or public.is_admin());

create policy collab_projects_read on public.collaboration_projects for select using (public.is_admin() or public.is_collaboration_member(id));
create policy collab_projects_manage on public.collaboration_projects for all using (public.is_admin() or public.is_collaboration_member(id)) with check (public.is_admin() or public.is_collaboration_member(id));
create policy collab_members_read on public.collaboration_members for select using (public.is_admin() or user_id=auth.uid() or public.is_collaboration_member(project_id));
create policy collab_members_manage on public.collaboration_members for all using (public.is_admin() or public.is_collaboration_member(project_id)) with check (public.is_admin() or user_id=auth.uid() or public.is_collaboration_member(project_id));
create policy collab_files_read on public.collaboration_files for select using (public.is_admin() or public.is_collaboration_member(project_id));
create policy collab_files_manage on public.collaboration_files for all using (public.is_admin() or public.is_collaboration_member(project_id)) with check (public.is_admin() or public.is_collaboration_member(project_id));
create policy collab_comments_read on public.collaboration_comments for select using (public.is_admin() or public.is_collaboration_member(project_id));
create policy collab_comments_insert on public.collaboration_comments for insert with check (user_id=auth.uid() and public.is_collaboration_member(project_id));
create policy collab_credits_read on public.collaboration_credits for select using (public.is_admin() or public.is_collaboration_member(project_id));
create policy collab_credits_manage on public.collaboration_credits for all using (public.is_admin() or public.is_collaboration_member(project_id)) with check (public.is_admin() or public.is_collaboration_member(project_id));

create policy favorites_self on public.favorites for all using (user_id=auth.uid()) with check (user_id=auth.uid());
create policy playlists_self on public.playlists for all using (user_id=auth.uid()) with check (user_id=auth.uid());
create policy playlist_items_self on public.playlist_items for all using (exists(select 1 from public.playlists p where p.id=playlist_id and p.user_id=auth.uid())) with check (exists(select 1 from public.playlists p where p.id=playlist_id and p.user_id=auth.uid()));

grant select on public.admin_users to authenticated;
grant execute on function public.reserve_beat(uuid,text,text) to authenticated;

-- Après avoir créé ton compte admin dans l'interface, remplace l'adresse puis exécute :
-- update public.profiles set role='Admin', verified=true where user_id=(select id from auth.users where email='TON-EMAIL');
