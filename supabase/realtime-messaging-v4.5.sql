-- DanaTrap RSX V4.5 — Messagerie temps réel, présence, saisie et accusés de lecture
-- À exécuter UNE FOIS dans Supabase > SQL Editor > New query > Run.

begin;

alter table public.profiles
  add column if not exists last_seen_at timestamptz not null default now();

create table if not exists public.message_reads (
  message_id uuid not null references public.messages(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create index if not exists conversation_members_user_conversation_idx
  on public.conversation_members(user_id, conversation_id);
create index if not exists messages_conversation_created_idx
  on public.messages(conversation_id, created_at);
create index if not exists message_reads_conversation_user_idx
  on public.message_reads(conversation_id, user_id, read_at desc);

alter table public.message_reads enable row level security;

drop policy if exists message_reads_read on public.message_reads;
create policy message_reads_read
on public.message_reads for select to authenticated
using (public.is_admin() or public.is_conversation_member(conversation_id));

drop policy if exists message_reads_insert on public.message_reads;
create policy message_reads_insert
on public.message_reads for insert to authenticated
with check (user_id=auth.uid() and public.is_conversation_member(conversation_id));

drop policy if exists message_reads_update on public.message_reads;
create policy message_reads_update
on public.message_reads for update to authenticated
using (user_id=auth.uid() and public.is_conversation_member(conversation_id))
with check (user_id=auth.uid() and public.is_conversation_member(conversation_id));

create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path=public
as $$
declare
  v_read_at timestamptz := now();
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if not public.is_conversation_member(p_conversation_id) and not public.is_admin() then
    raise exception 'Conversation inaccessible';
  end if;

  insert into public.message_reads(message_id, conversation_id, user_id, read_at)
  select m.id, m.conversation_id, auth.uid(), v_read_at
  from public.messages m
  where m.conversation_id=p_conversation_id
    and m.sender_id<>auth.uid()
  on conflict (message_id,user_id)
  do update set read_at=excluded.read_at;

  return v_read_at;
end;
$$;

grant execute on function public.mark_conversation_read(uuid) to authenticated;

create or replace function public.notify_new_chat_message()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_sender_name text;
begin
  if new.type <> 'text' then return new; end if;
  select name into v_sender_name from public.profiles where user_id=new.sender_id;

  insert into public.notifications(user_id,type,title,body,link)
  select cm.user_id,
         'message',
         'Nouveau message de '||coalesce(v_sender_name,'un membre'),
         left(new.text,120),
         '#/app/messages/'||new.conversation_id::text
  from public.conversation_members cm
  where cm.conversation_id=new.conversation_id
    and cm.user_id<>new.sender_id;

  return new;
end;
$$;

drop trigger if exists message_creates_notifications on public.messages;
create trigger message_creates_notifications
after insert on public.messages
for each row execute function public.notify_new_chat_message();

-- Convertit sans erreur un topic « conversation:<uuid> » en UUID.
create or replace function public.realtime_conversation_id(p_topic text)
returns uuid
language plpgsql
immutable
as $$
begin
  if p_topic !~ '^conversation:[0-9a-fA-F-]{36}$' then return null; end if;
  return split_part(p_topic,':',2)::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

grant execute on function public.realtime_conversation_id(text) to authenticated;

-- Canaux privés : présence globale pour les membres connectés,
-- présence + saisie + lecture uniquement pour les membres de la conversation.
drop policy if exists drsx_realtime_read on realtime.messages;
create policy drsx_realtime_read
on realtime.messages
for select
to authenticated
using (
  (
    realtime.messages.extension='presence'
    and (select realtime.topic())='presence:global'
  )
  or
  (
    realtime.messages.extension in ('presence','broadcast')
    and exists (
      select 1
      from public.conversation_members cm
      where cm.user_id=(select auth.uid())
        and cm.conversation_id=public.realtime_conversation_id((select realtime.topic()))
    )
  )
);

drop policy if exists drsx_realtime_write on realtime.messages;
create policy drsx_realtime_write
on realtime.messages
for insert
to authenticated
with check (
  (
    realtime.messages.extension='presence'
    and (select realtime.topic())='presence:global'
  )
  or
  (
    realtime.messages.extension in ('presence','broadcast')
    and exists (
      select 1
      from public.conversation_members cm
      where cm.user_id=(select auth.uid())
        and cm.conversation_id=public.realtime_conversation_id((select realtime.topic()))
    )
  )
);

-- Active les événements Postgres Realtime nécessaires, sans erreur en cas de relance.
do $$
begin
  if exists (select 1 from pg_publication where pubname='supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='messages') then
      alter publication supabase_realtime add table public.messages;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='message_reads') then
      alter publication supabase_realtime add table public.message_reads;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='profiles') then
      alter publication supabase_realtime add table public.profiles;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='notifications') then
      alter publication supabase_realtime add table public.notifications;
    end if;
  end if;
end $$;

commit;
