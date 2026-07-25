-- DanaTrap RSX V5 — Phase 1 R2 : fondations (correctif vue admin)
-- Migration compatible avec la V4.5 existante.
-- Objectifs : rôles multiples, permission Admin séparée, réservations 48 h,
-- protection contre les doubles réservations, liste d'attente, historique,
-- notifications/messages de statut, journaux, corbeille, paramètres et base Aspect.
--
-- À exécuter UNE SEULE FOIS dans Supabase > SQL Editor > New query > Run.

begin;

create extension if not exists pgcrypto;

create table if not exists public.drsx_schema_migrations (
  version text primary key,
  description text not null,
  applied_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 1. Rôles multiples et permission administrateur séparée
-- -----------------------------------------------------------------------------

alter table public.profiles
  add column if not exists roles text[] not null default array['Artiste']::text[],
  add column if not exists is_admin boolean not null default false,
  add column if not exists availability_status text not null default 'available',
  add column if not exists show_presence boolean not null default true,
  add column if not exists last_login_at timestamptz,
  add column if not exists password_change_required boolean not null default false,
  add column if not exists notification_preferences jsonb not null default '{"messages":true,"reservations":true,"reservation_reminders":true,"email":true,"browser":true}'::jsonb,
  add column if not exists privacy_settings jsonb not null default '{"show_online":true,"show_last_seen":true,"allow_messages":"everyone","allow_profile_search":true}'::jsonb,
  add column if not exists integration_settings jsonb not null default '{}'::jsonb,
  add column if not exists profile_draft jsonb not null default '{}'::jsonb;

alter table public.profiles drop constraint if exists profiles_availability_status_check;
alter table public.profiles
  add constraint profiles_availability_status_check
  check (availability_status in ('available','busy','dnd','offline'));

create or replace function public.normalize_member_roles(p_roles text[])
returns text[]
language sql
immutable
as $$
  select coalesce(
    array_agg(distinct r order by r),
    array['Artiste']::text[]
  )
  from unnest(coalesce(p_roles,array[]::text[])) as r
  where r in ('Beatmaker','Artiste','Producteur','Ingénieur du son','Manager');
$$;

update public.profiles p
set
  is_admin = (p.role = 'Admin'),
  roles = case
    when p.role = 'Admin' then
      case
        when exists(select 1 from public.beats b where b.producer_id=p.user_id)
          then array['Beatmaker']::text[]
        else array['Artiste']::text[]
      end
    else public.normalize_member_roles(array[p.role]::text[])
  end
where p.roles = array['Artiste']::text[]
   or p.roles is null
   or p.is_admin is distinct from (p.role='Admin');

create or replace function public.user_has_role(p_user_id uuid,p_role text)
returns boolean
language sql
stable
security definer
set search_path=public
as $$
  select exists(
    select 1
    from public.profiles p
    where p.user_id=p_user_id
      and p_role=any(p.roles)
  );
$$;

create or replace function public.current_user_has_role(p_role text)
returns boolean
language sql
stable
security definer
set search_path=public
as $$
  select public.user_has_role(auth.uid(),p_role);
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path=public
as $$
  select exists(
    select 1
    from public.profiles p
    where p.user_id=auth.uid()
      and (p.is_admin=true or p.role='Admin')
  );
$$;

create or replace function public.enforce_profile_roles()
returns trigger
language plpgsql
set search_path=public
as $$
begin
  new.roles := public.normalize_member_roles(new.roles);
  if cardinality(new.roles)=0 then new.roles := array['Artiste']::text[]; end if;

  -- Le champ historique role reste présent pour compatibilité avec la V4.5.
  if new.is_admin then
    new.role := 'Admin';
  elsif new.role='Admin' or new.role is null or not (new.role=any(new.roles)) then
    new.role := new.roles[1];
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_enforce_roles on public.profiles;
create trigger profiles_enforce_roles
before insert or update of roles,is_admin,role on public.profiles
for each row execute function public.enforce_profile_roles();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_name text := coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1));
  v_role text := coalesce(new.raw_user_meta_data->>'role','Artiste');
  v_slug text;
begin
  -- Admin ne peut jamais être choisi depuis l'inscription publique.
  if v_role not in ('Beatmaker','Artiste','Producteur','Ingénieur du son','Manager') then
    v_role := 'Artiste';
  end if;
  v_slug := public.make_slug(v_name)||'-'||substr(new.id::text,1,5);

  insert into public.profiles(
    user_id,slug,name,username,role,roles,is_admin,initials,last_login_at
  ) values(
    new.id,
    v_slug,
    v_name,
    '@'||replace(public.make_slug(v_name),'-',''),
    v_role,
    array[v_role]::text[],
    false,
    upper(substr(v_name,1,2)),
    now()
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- Empêche un membre connecté de s'attribuer Admin ou de modifier ses rôles directement.
revoke update on public.profiles from authenticated;
grant update (
  name,username,initials,bio,location,avatar,banner,socials,theme,
  availability_status,show_presence,last_seen_at,last_login_at,
  notification_preferences,privacy_settings,integration_settings,profile_draft,updated_at
) on public.profiles to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Réservations V5 : 48 h, verrouillage, liste d'attente et historique
-- -----------------------------------------------------------------------------

alter table public.messages drop constraint if exists messages_type_check;
alter table public.messages
  add constraint messages_type_check
  check (type in ('text','reservation','reservation_status','system','file'));

alter table public.messages
  add column if not exists edited_at timestamptz,
  add column if not exists deleted_at timestamptz,
  add column if not exists search_text text generated always as (lower(coalesce(text,''))) stored;

alter table public.notifications
  add column if not exists payload jsonb not null default '{}'::jsonb;

alter table public.conversations
  add column if not exists pinned_payload jsonb not null default '{}'::jsonb,
  add column if not exists archived_at timestamptz;

alter table public.conversation_members
  add column if not exists last_read_at timestamptz,
  add column if not exists muted boolean not null default false,
  add column if not exists archived boolean not null default false;

alter table public.reservations drop constraint if exists reservations_status_check;
alter table public.reservations
  add column if not exists license_id uuid references public.licenses(id) on delete set null,
  add column if not exists expires_at timestamptz,
  add column if not exists decided_at timestamptz,
  add column if not exists decided_by uuid references public.profiles(user_id) on delete set null,
  add column if not exists decision_reason text not null default '',
  add column if not exists queue_position integer,
  add column if not exists license_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists status_history jsonb not null default '[]'::jsonb;

update public.reservations
set expires_at=coalesce(expires_at,created_at+interval '48 hours')
where expires_at is null;

alter table public.reservations
  alter column expires_at set default (now()+interval '48 hours');

alter table public.reservations
  add constraint reservations_status_check
  check (status in ('En attente','En discussion','Acceptée','Refusée','Annulée','Expirée','Terminée'));

create table if not exists public.reservation_events (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  beat_id uuid not null references public.beats(id) on delete cascade,
  actor_id uuid references public.profiles(user_id) on delete set null,
  event_type text not null,
  old_status text,
  new_status text,
  message text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.beat_waitlist (
  id uuid primary key default gen_random_uuid(),
  beat_id uuid not null references public.beats(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  license_name text not null,
  note text not null default '',
  position integer not null,
  status text not null default 'waiting'
    check (status in ('waiting','notified','promoted','cancelled')),
  notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists beat_waitlist_unique_active_user
on public.beat_waitlist(beat_id,user_id)
where status in ('waiting','notified');

create index if not exists beat_waitlist_order_idx
on public.beat_waitlist(beat_id,status,position,created_at);

create index if not exists reservations_expiry_idx
on public.reservations(status,expires_at)
where status='En discussion';

-- En cas de doublons historiques, conserve la plus ancienne demande active et annule les suivantes.
with ranked_active as (
  select id,row_number() over(partition by beat_id order by created_at,id) as rn
  from public.reservations
  where status in ('En discussion','Acceptée')
)
update public.reservations r
set status='Annulée',
    decided_at=coalesce(r.decided_at,now()),
    decision_reason=case when r.decision_reason='' then 'Doublon historique corrigé pendant la migration V5' else r.decision_reason end
from ranked_active x
where r.id=x.id and x.rn>1;

create unique index if not exists reservations_one_active_per_beat
on public.reservations(beat_id)
where status in ('En discussion','Acceptée');

create index if not exists reservation_events_reservation_idx
on public.reservation_events(reservation_id,created_at);

create or replace function public.reservation_cover_payload(p_beat public.beats)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'beat_id',p_beat.id,
    'slug',p_beat.slug,
    'title',p_beat.title,
    'producer_id',p_beat.producer_id,
    'producer_name',p_beat.producer_name,
    'cover_image',p_beat.cover_image,
    'cover_class',p_beat.cover_class,
    'bpm',p_beat.bpm,
    'key',p_beat.key,
    'genre',p_beat.genre
  );
$$;

create or replace function public.notify_waitlist_available_v5(p_beat_id uuid)
returns integer
language plpgsql
security definer
set search_path=public
as $$
declare
  v_beat public.beats%rowtype;
  v_wait public.beat_waitlist%rowtype;
begin
  select * into v_beat from public.beats where id=p_beat_id;
  if not found then return 0; end if;

  select * into v_wait
  from public.beat_waitlist
  where beat_id=p_beat_id and status='waiting'
  order by position,created_at
  limit 1
  for update skip locked;

  if not found then return 0; end if;

  update public.beat_waitlist
  set status='notified',notified_at=now(),updated_at=now()
  where id=v_wait.id;

  insert into public.notifications(user_id,type,title,body,link,payload)
  values(
    v_wait.user_id,
    'waitlist',
    v_beat.title||' est de nouveau disponible',
    'Tu étais sur la liste d’attente. Tu peux maintenant tenter de réserver la production.',
    '#/beat/'||v_beat.slug,
    public.reservation_cover_payload(v_beat)||jsonb_build_object('waitlist_id',v_wait.id)
  );

  return 1;
end;
$$;

create or replace function public.reserve_beat_v5(
  p_beat_id uuid,
  p_license_name text,
  p_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_beat public.beats%rowtype;
  v_artist public.profiles%rowtype;
  v_license public.licenses%rowtype;
  v_active public.reservations%rowtype;
  v_conv uuid;
  v_res uuid;
  v_wait uuid;
  v_position integer;
  v_payload jsonb;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;

  select * into v_artist from public.profiles where user_id=auth.uid();
  if not found then raise exception 'Profil introuvable'; end if;

  if not (public.user_has_role(auth.uid(),'Artiste') or public.is_admin()) then
    raise exception 'Un rôle Artiste est nécessaire pour réserver une production';
  end if;

  select * into v_beat from public.beats where id=p_beat_id for update;
  if not found then raise exception 'Production introuvable'; end if;
  if v_beat.visibility in ('Brouillon','Expiré') then
    raise exception 'Cette production n’est pas disponible';
  end if;
  if v_beat.producer_id=auth.uid() then
    raise exception 'Tu ne peux pas réserver ta propre production';
  end if;

  -- Nettoyage opportuniste avant de décider si la production est libre.
  perform public.expire_reservations_v5(p_beat_id);

  select * into v_active
  from public.reservations
  where beat_id=p_beat_id and status in ('En discussion','Acceptée')
  order by created_at
  limit 1
  for update;

  if found then
    select coalesce(max(position),0)+1 into v_position
    from public.beat_waitlist
    where beat_id=p_beat_id and status in ('waiting','notified');

    insert into public.beat_waitlist(beat_id,user_id,license_name,note,position,status)
    values(p_beat_id,auth.uid(),p_license_name,coalesce(p_note,''),v_position,'waiting')
    on conflict (beat_id,user_id) where status in ('waiting','notified')
    do update set
      license_name=excluded.license_name,
      note=excluded.note,
      updated_at=now()
    returning id into v_wait;

    insert into public.notifications(user_id,type,title,body,link,payload)
    values(
      auth.uid(),
      'waitlist',
      'Ajouté à la liste d’attente',
      v_beat.title||' est actuellement réservée. Position : '||v_position,
      '#/beat/'||v_beat.slug,
      public.reservation_cover_payload(v_beat)||jsonb_build_object('position',v_position,'waitlist_id',v_wait)
    );

    return jsonb_build_object(
      'waitlisted',true,
      'waitlist_id',v_wait,
      'position',v_position,
      'beat_id',p_beat_id
    );
  end if;

  select * into v_license
  from public.licenses
  where beat_id=p_beat_id and active=true and name=p_license_name
  order by sort_order,id
  limit 1;

  v_payload := public.reservation_cover_payload(v_beat)
    || jsonb_build_object(
      'license_name',p_license_name,
      'status','En discussion',
      'note',coalesce(p_note,''),
      'expires_at',now()+interval '48 hours'
    );

  insert into public.conversations(title,beat_id,pinned_payload)
  values(v_artist.name||' · '||v_beat.title,p_beat_id,v_payload)
  returning id into v_conv;

  insert into public.conversation_members(conversation_id,user_id)
  values(v_conv,auth.uid()),(v_conv,v_beat.producer_id)
  on conflict do nothing;

  insert into public.reservations(
    beat_id,artist_id,beatmaker_id,license_name,license_id,status,
    conversation_id,expires_at,license_snapshot,status_history
  ) values(
    p_beat_id,
    auth.uid(),
    v_beat.producer_id,
    p_license_name,
    v_license.id,
    'En discussion',
    v_conv,
    now()+interval '48 hours',
    case when v_license.id is null
      then jsonb_build_object('name',p_license_name)
      else to_jsonb(v_license)-'id'-'beat_id'-'created_at'
    end,
    jsonb_build_array(jsonb_build_object('status','En discussion','at',now(),'by',auth.uid()))
  ) returning id into v_res;

  insert into public.messages(conversation_id,sender_id,type,text,payload)
  values(v_conv,auth.uid(),'reservation','Réservation envoyée',v_payload||jsonb_build_object('reservation_id',v_res));

  if length(trim(coalesce(p_note,'')))>0 then
    insert into public.messages(conversation_id,sender_id,type,text)
    values(v_conv,auth.uid(),'text',p_note);
  end if;

  insert into public.reservation_events(
    reservation_id,beat_id,actor_id,event_type,new_status,message,payload
  ) values(
    v_res,p_beat_id,auth.uid(),'created','En discussion','Réservation créée',v_payload
  );

  insert into public.notifications(user_id,type,title,body,link,payload)
  values(
    v_beat.producer_id,
    'reservation',
    v_beat.title||' a été réservée',
    v_artist.name||' a choisi la licence '||p_license_name||'. Réponds sous 48 heures.',
    '#/app/messages/'||v_conv::text,
    v_payload||jsonb_build_object('reservation_id',v_res,'conversation_id',v_conv)
  );

  update public.beats set visibility='Réservé' where id=p_beat_id;

  return jsonb_build_object(
    'waitlisted',false,
    'reservation_id',v_res,
    'conversation_id',v_conv,
    'expires_at',now()+interval '48 hours',
    'conversation',jsonb_build_object('id',v_conv)
  );
end;
$$;

create or replace function public.decide_reservation_v5(
  p_reservation_id uuid,
  p_decision text,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_res public.reservations%rowtype;
  v_beat public.beats%rowtype;
  v_actor public.profiles%rowtype;
  v_new_status text;
  v_payload jsonb;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_decision not in ('Acceptée','Refusée') then
    raise exception 'Décision invalide';
  end if;

  select * into v_res from public.reservations where id=p_reservation_id for update;
  if not found then raise exception 'Réservation introuvable'; end if;
  if not (public.is_admin() or v_res.beatmaker_id=auth.uid()) then
    raise exception 'Action réservée au beatmaker ou à l’administrateur';
  end if;
  if v_res.status not in ('En discussion','Acceptée') then
    raise exception 'Cette réservation a déjà été traitée';
  end if;

  select * into v_beat from public.beats where id=v_res.beat_id for update;
  select * into v_actor from public.profiles where user_id=auth.uid();
  v_new_status := p_decision;
  v_payload := public.reservation_cover_payload(v_beat)
    || jsonb_build_object(
      'reservation_id',v_res.id,
      'license_name',v_res.license_name,
      'status',v_new_status,
      'reason',coalesce(p_reason,''),
      'decided_by',coalesce(v_actor.name,'Administrateur')
    );

  update public.reservations
  set
    status=v_new_status,
    decided_at=now(),
    decided_by=auth.uid(),
    decision_reason=coalesce(p_reason,''),
    status_history=status_history||jsonb_build_array(
      jsonb_build_object('status',v_new_status,'at',now(),'by',auth.uid(),'reason',coalesce(p_reason,''))
    )
  where id=v_res.id;

  insert into public.messages(conversation_id,sender_id,type,text,payload)
  values(
    v_res.conversation_id,
    auth.uid(),
    'reservation_status',
    case when v_new_status='Acceptée'
      then 'La réservation a été acceptée.'
      else 'La réservation a été refusée.'
    end,
    v_payload
  );

  insert into public.reservation_events(
    reservation_id,beat_id,actor_id,event_type,old_status,new_status,message,payload
  ) values(
    v_res.id,v_res.beat_id,auth.uid(),lower(v_new_status),v_res.status,v_new_status,
    case when v_new_status='Acceptée' then 'Réservation acceptée' else 'Réservation refusée' end,
    v_payload
  );

  insert into public.notifications(user_id,type,title,body,link,payload)
  values(
    v_res.artist_id,
    'reservation_status',
    case when v_new_status='Acceptée'
      then 'Réservation acceptée'
      else 'Réservation refusée'
    end,
    case when v_new_status='Acceptée'
      then v_beat.title||' : le beatmaker a accepté ta demande.'
      else v_beat.title||' : la production est de nouveau disponible.'
    end,
    '#/app/messages/'||v_res.conversation_id::text,
    v_payload
  );

  if v_new_status='Acceptée' then
    update public.beats set visibility='Réservé' where id=v_res.beat_id;
  else
    update public.beats set visibility='Publié' where id=v_res.beat_id and visibility<>'Expiré';
    perform public.notify_waitlist_available_v5(v_res.beat_id);
  end if;

  return jsonb_build_object('reservation_id',v_res.id,'status',v_new_status,'beat_id',v_res.beat_id);
end;
$$;

create or replace function public.cancel_reservation_v5(
  p_reservation_id uuid,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_res public.reservations%rowtype;
  v_beat public.beats%rowtype;
  v_payload jsonb;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  select * into v_res from public.reservations where id=p_reservation_id for update;
  if not found then raise exception 'Réservation introuvable'; end if;
  if not (public.is_admin() or v_res.artist_id=auth.uid()) then
    raise exception 'Tu ne peux pas annuler cette réservation';
  end if;
  if v_res.status not in ('En discussion','Acceptée') then
    raise exception 'Cette réservation ne peut plus être annulée';
  end if;

  select * into v_beat from public.beats where id=v_res.beat_id for update;
  v_payload := public.reservation_cover_payload(v_beat)
    || jsonb_build_object('reservation_id',v_res.id,'license_name',v_res.license_name,'status','Annulée','reason',coalesce(p_reason,''));

  update public.reservations
  set status='Annulée',decided_at=now(),decided_by=auth.uid(),decision_reason=coalesce(p_reason,''),
      status_history=status_history||jsonb_build_array(jsonb_build_object('status','Annulée','at',now(),'by',auth.uid(),'reason',coalesce(p_reason,'')))
  where id=v_res.id;

  insert into public.messages(conversation_id,sender_id,type,text,payload)
  values(v_res.conversation_id,auth.uid(),'reservation_status','La réservation a été annulée.',v_payload);

  insert into public.reservation_events(reservation_id,beat_id,actor_id,event_type,old_status,new_status,message,payload)
  values(v_res.id,v_res.beat_id,auth.uid(),'cancelled',v_res.status,'Annulée','Réservation annulée',v_payload);

  insert into public.notifications(user_id,type,title,body,link,payload)
  values(v_res.beatmaker_id,'reservation_status','Réservation annulée',v_beat.title||' est de nouveau disponible.','#/app/messages/'||v_res.conversation_id::text,v_payload);

  update public.beats set visibility='Publié' where id=v_res.beat_id and visibility<>'Expiré';
  perform public.notify_waitlist_available_v5(v_res.beat_id);

  return jsonb_build_object('reservation_id',v_res.id,'status','Annulée');
end;
$$;

create or replace function public.expire_reservations_v5(p_beat_id uuid default null)
returns integer
language plpgsql
security definer
set search_path=public
as $$
declare
  v_res public.reservations%rowtype;
  v_beat public.beats%rowtype;
  v_payload jsonb;
  v_count integer := 0;
begin
  for v_res in
    select *
    from public.reservations
    where status='En discussion'
      and expires_at<=now()
      and (p_beat_id is null or beat_id=p_beat_id)
    order by expires_at
    for update skip locked
  loop
    select * into v_beat from public.beats where id=v_res.beat_id for update;
    v_payload := public.reservation_cover_payload(v_beat)
      || jsonb_build_object('reservation_id',v_res.id,'license_name',v_res.license_name,'status','Expirée');

    update public.reservations
    set status='Expirée',decided_at=now(),decision_reason='Aucune réponse sous 48 heures',
        status_history=status_history||jsonb_build_array(jsonb_build_object('status','Expirée','at',now(),'reason','Aucune réponse sous 48 heures'))
    where id=v_res.id;

    insert into public.messages(conversation_id,sender_id,type,text,payload)
    values(v_res.conversation_id,v_res.beatmaker_id,'reservation_status','La réservation a expiré après 48 heures.',v_payload);

    insert into public.reservation_events(reservation_id,beat_id,event_type,old_status,new_status,message,payload)
    values(v_res.id,v_res.beat_id,'expired',v_res.status,'Expirée','Expiration automatique après 48 heures',v_payload);

    insert into public.notifications(user_id,type,title,body,link,payload)
    values
      (v_res.artist_id,'reservation_status','Réservation expirée',v_beat.title||' est de nouveau disponible.','#/app/messages/'||v_res.conversation_id::text,v_payload),
      (v_res.beatmaker_id,'reservation_status','Réservation expirée','Tu n’as pas répondu sous 48 heures. '||v_beat.title||' est de nouveau disponible.','#/app/messages/'||v_res.conversation_id::text,v_payload);

    update public.beats set visibility='Publié' where id=v_res.beat_id and visibility<>'Expiré';
    perform public.notify_waitlist_available_v5(v_res.beat_id);
    v_count := v_count+1;
  end loop;
  return v_count;
end;
$$;

-- Rappels visibles dans le centre de notifications à 24 h et 2 h de l'expiration.
alter table public.reservations
  add column if not exists reminder_24h_sent boolean not null default false,
  add column if not exists reminder_2h_sent boolean not null default false;

create or replace function public.send_reservation_reminders_v5()
returns integer
language plpgsql
security definer
set search_path=public
as $$
declare
  v_res public.reservations%rowtype;
  v_beat public.beats%rowtype;
  v_count integer := 0;
begin
  for v_res in
    select * from public.reservations
    where status='En discussion'
      and expires_at>now()
      and (
        (reminder_24h_sent=false and expires_at<=now()+interval '24 hours')
        or
        (reminder_2h_sent=false and expires_at<=now()+interval '2 hours')
      )
    for update skip locked
  loop
    select * into v_beat from public.beats where id=v_res.beat_id;
    if v_res.expires_at<=now()+interval '2 hours' and not v_res.reminder_2h_sent then
      insert into public.notifications(user_id,type,title,body,link,payload)
      values(v_res.beatmaker_id,'reservation_reminder','Réservation bientôt expirée',v_beat.title||' expire dans moins de 2 heures.','#/app/reservations',public.reservation_cover_payload(v_beat)||jsonb_build_object('reservation_id',v_res.id));
      update public.reservations set reminder_2h_sent=true where id=v_res.id;
      v_count:=v_count+1;
    elsif not v_res.reminder_24h_sent then
      insert into public.notifications(user_id,type,title,body,link,payload)
      values(v_res.beatmaker_id,'reservation_reminder','Réservation en attente',v_beat.title||' expire dans moins de 24 heures.','#/app/reservations',public.reservation_cover_payload(v_beat)||jsonb_build_object('reservation_id',v_res.id));
      update public.reservations set reminder_24h_sent=true where id=v_res.id;
      v_count:=v_count+1;
    end if;
  end loop;
  return v_count;
end;
$$;

grant execute on function public.reserve_beat_v5(uuid,text,text) to authenticated;
grant execute on function public.decide_reservation_v5(uuid,text,text) to authenticated;
grant execute on function public.cancel_reservation_v5(uuid,text) to authenticated;
grant execute on function public.expire_reservations_v5(uuid) to authenticated;
grant execute on function public.send_reservation_reminders_v5() to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Journaux, corbeille, sauvegardes, récupération et modération
-- -----------------------------------------------------------------------------

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(user_id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.error_logs (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(user_id) on delete set null,
  source text not null default 'frontend',
  level text not null default 'error' check (level in ('info','warning','error','fatal')),
  message text not null,
  stack text not null default '',
  context jsonb not null default '{}'::jsonb,
  resolved boolean not null default false,
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.trash_items (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id text not null,
  owner_id uuid references public.profiles(user_id) on delete set null,
  deleted_by uuid references public.profiles(user_id) on delete set null,
  snapshot jsonb not null,
  drive_files jsonb not null default '[]'::jsonb,
  restore_until timestamptz not null default (now()+interval '30 days'),
  restored_at timestamptz,
  permanently_deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.backup_runs (
  id uuid primary key default gen_random_uuid(),
  started_by uuid references public.profiles(user_id) on delete set null,
  status text not null default 'pending' check (status in ('pending','running','completed','failed')),
  scope text not null default 'full',
  manifest jsonb not null default '{}'::jsonb,
  error_message text not null default '',
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.account_recovery_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(user_id) on delete set null,
  email text not null,
  status text not null default 'pending' check (status in ('pending','processing','completed','rejected')),
  message text not null default '',
  handled_by uuid references public.profiles(user_id) on delete set null,
  handled_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(user_id) on delete cascade,
  target_type text not null check (target_type in ('profile','beat','message','conversation','announcement','file')),
  target_id text not null,
  reason text not null,
  details text not null default '',
  status text not null default 'open' check (status in ('open','reviewing','resolved','dismissed')),
  assigned_to uuid references public.profiles(user_id) on delete set null,
  resolution text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.moderation_queue (
  id uuid primary key default gen_random_uuid(),
  source_type text not null,
  source_id text not null,
  reason text not null,
  severity text not null default 'medium' check (severity in ('low','medium','high','critical')),
  status text not null default 'pending' check (status in ('pending','reviewing','approved','hidden','rejected')),
  payload jsonb not null default '{}'::jsonb,
  reviewed_by uuid references public.profiles(user_id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_tasks (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  title text not null,
  description text not null default '',
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status text not null default 'open' check (status in ('open','in_progress','completed','dismissed')),
  related_type text,
  related_id text,
  assigned_to uuid references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.system_health_checks (
  id bigint generated always as identity primary key,
  service text not null,
  status text not null,
  response_time_ms integer,
  details jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 4. Aspect, thèmes, badges, fonctions activables et obligations légales
-- -----------------------------------------------------------------------------

create table if not exists public.site_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  public_read boolean not null default false,
  updated_by uuid references public.profiles(user_id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.feature_flags (
  key text primary key,
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  description text not null default '',
  updated_by uuid references public.profiles(user_id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.site_themes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  settings jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(user_id) on delete set null,
  published_by uuid references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  published_at timestamptz
);

create table if not exists public.badges (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  description text not null default '',
  icon text not null default '',
  style jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.profile_badges (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  badge_id uuid not null references public.badges(id) on delete cascade,
  assigned_by uuid references public.profiles(user_id) on delete set null,
  assigned_at timestamptz not null default now(),
  primary key(user_id,badge_id)
);

create table if not exists public.legal_documents (
  id uuid primary key default gen_random_uuid(),
  document_type text not null check (document_type in ('terms','privacy','community','storage','license')),
  version text not null,
  title text not null,
  content text not null,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  unique(document_type,version)
);

create table if not exists public.user_consents (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  document_id uuid not null references public.legal_documents(id) on delete cascade,
  accepted_at timestamptz not null default now(),
  ip_hash text,
  user_agent text,
  primary key(user_id,document_id)
);

create table if not exists public.follows (
  follower_id uuid not null references public.profiles(user_id) on delete cascade,
  followed_id uuid not null references public.profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(follower_id,followed_id),
  check (follower_id<>followed_id)
);

create table if not exists public.user_blocks (
  blocker_id uuid not null references public.profiles(user_id) on delete cascade,
  blocked_id uuid not null references public.profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(blocker_id,blocked_id),
  check (blocker_id<>blocked_id)
);

create table if not exists public.recommendation_preferences (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  preferred_genres text[] not null default array[]::text[],
  hidden_genres text[] not null default array[]::text[],
  preferred_bpm_min integer,
  preferred_bpm_max integer,
  preferred_keys text[] not null default array[]::text[],
  updated_at timestamptz not null default now()
);

insert into public.feature_flags(key,enabled,description)
values
  ('registrations',true,'Autoriser les inscriptions'),
  ('reservations',true,'Autoriser les réservations'),
  ('messaging',true,'Autoriser la messagerie'),
  ('uploads',true,'Autoriser les uploads'),
  ('announcements',true,'Autoriser les annonces'),
  ('collaborations',true,'Autoriser les collaborations'),
  ('badges',true,'Afficher les badges'),
  ('maintenance_mode',false,'Mettre le site en maintenance'),
  ('browser_notifications',true,'Autoriser les notifications navigateur'),
  ('email_notifications',true,'Autoriser les notifications e-mail')
on conflict (key) do nothing;

insert into public.site_settings(key,value,public_read)
values
  ('global_appearance','{"mode":"gradient","solidColor":"#070708","gradient":"linear-gradient(135deg,#070708,#111217)","logo":"","favicon":"","backgroundImage":"","effects":true}'::jsonb,true),
  ('maintenance','{"enabled":false,"title":"Maintenance","message":"DanaTrap RSX revient bientôt."}'::jsonb,true),
  ('reservation_rules','{"expirationHours":48,"reminderHours":[24,2],"waitlist":true}'::jsonb,true)
on conflict (key) do nothing;

insert into public.badges(slug,name,description)
values
  ('verified','Vérifié','Profil vérifié par DanaTrap RSX'),
  ('founder','Fondateur','Membre fondateur de DanaTrap RSX'),
  ('partner','Partenaire','Partenaire officiel'),
  ('top-beatmaker','Top Beatmaker','Beatmaker mis en avant'),
  ('new-talent','Nouveau talent','Créateur émergent à découvrir')
on conflict (slug) do nothing;

-- -----------------------------------------------------------------------------
-- 5. Audit automatique des principales tables
-- -----------------------------------------------------------------------------

create or replace function public.log_audit_change()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_entity_id text;
begin
  v_entity_id := coalesce(to_jsonb(new)->>'id',to_jsonb(old)->>'id',to_jsonb(new)->>'key',to_jsonb(old)->>'key');
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,before_data,after_data)
  values(
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    v_entity_id,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) else null end
  );
  if tg_op='DELETE' then
    return old;
  end if;
  return new;
end;
$$;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['profiles','beats','reservations','site_settings','feature_flags','badges'] loop
    execute format('drop trigger if exists %I_audit_v5 on public.%I',v_table,v_table);
    execute format('create trigger %I_audit_v5 after insert or update or delete on public.%I for each row execute function public.log_audit_change()',v_table,v_table);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 6. RLS et permissions
-- -----------------------------------------------------------------------------

alter table public.reservation_events enable row level security;
alter table public.beat_waitlist enable row level security;
alter table public.audit_logs enable row level security;
alter table public.error_logs enable row level security;
alter table public.trash_items enable row level security;
alter table public.backup_runs enable row level security;
alter table public.account_recovery_requests enable row level security;
alter table public.reports enable row level security;
alter table public.moderation_queue enable row level security;
alter table public.admin_tasks enable row level security;
alter table public.system_health_checks enable row level security;
alter table public.site_settings enable row level security;
alter table public.feature_flags enable row level security;
alter table public.site_themes enable row level security;
alter table public.badges enable row level security;
alter table public.profile_badges enable row level security;
alter table public.legal_documents enable row level security;
alter table public.user_consents enable row level security;
alter table public.follows enable row level security;
alter table public.user_blocks enable row level security;
alter table public.recommendation_preferences enable row level security;

drop policy if exists reservation_events_read_v5 on public.reservation_events;
create policy reservation_events_read_v5 on public.reservation_events for select to authenticated
using (
  public.is_admin()
  or exists(select 1 from public.reservations r where r.id=reservation_id and (r.artist_id=auth.uid() or r.beatmaker_id=auth.uid()))
);

drop policy if exists beat_waitlist_read_v5 on public.beat_waitlist;
create policy beat_waitlist_read_v5 on public.beat_waitlist for select to authenticated
using (
  public.is_admin()
  or user_id=auth.uid()
  or exists(select 1 from public.beats b where b.id=beat_id and b.producer_id=auth.uid())
);

drop policy if exists beat_waitlist_self_delete_v5 on public.beat_waitlist;
create policy beat_waitlist_self_delete_v5 on public.beat_waitlist for delete to authenticated
using (user_id=auth.uid() or public.is_admin());

drop policy if exists audit_logs_admin_v5 on public.audit_logs;
create policy audit_logs_admin_v5 on public.audit_logs for select to authenticated using (public.is_admin());

drop policy if exists error_logs_insert_v5 on public.error_logs;
create policy error_logs_insert_v5 on public.error_logs for insert to authenticated
with check (user_id is null or user_id=auth.uid());
drop policy if exists error_logs_admin_v5 on public.error_logs;
create policy error_logs_admin_v5 on public.error_logs for select to authenticated using (public.is_admin() or user_id=auth.uid());

drop policy if exists trash_admin_v5 on public.trash_items;
create policy trash_admin_v5 on public.trash_items for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists backups_admin_v5 on public.backup_runs;
create policy backups_admin_v5 on public.backup_runs for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists recovery_self_insert_v5 on public.account_recovery_requests;
create policy recovery_self_insert_v5 on public.account_recovery_requests for insert to anon,authenticated
with check (user_id is null or user_id=auth.uid());
drop policy if exists recovery_self_read_v5 on public.account_recovery_requests;
create policy recovery_self_read_v5 on public.account_recovery_requests for select to authenticated
using (public.is_admin() or user_id=auth.uid());

drop policy if exists reports_insert_v5 on public.reports;
create policy reports_insert_v5 on public.reports for insert to authenticated with check (reporter_id=auth.uid());
drop policy if exists reports_read_v5 on public.reports;
create policy reports_read_v5 on public.reports for select to authenticated using (public.is_admin() or reporter_id=auth.uid());
drop policy if exists reports_admin_update_v5 on public.reports;
create policy reports_admin_update_v5 on public.reports for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists moderation_admin_v5 on public.moderation_queue;
create policy moderation_admin_v5 on public.moderation_queue for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists admin_tasks_admin_v5 on public.admin_tasks;
create policy admin_tasks_admin_v5 on public.admin_tasks for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists health_admin_v5 on public.system_health_checks;
create policy health_admin_v5 on public.system_health_checks for select to authenticated using (public.is_admin());

drop policy if exists site_settings_public_v5 on public.site_settings;
create policy site_settings_public_v5 on public.site_settings for select to anon,authenticated
using (public_read=true or public.is_admin());
drop policy if exists site_settings_admin_v5 on public.site_settings;
create policy site_settings_admin_v5 on public.site_settings for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists feature_flags_read_v5 on public.feature_flags;
create policy feature_flags_read_v5 on public.feature_flags for select to anon,authenticated using (true);
drop policy if exists feature_flags_admin_v5 on public.feature_flags;
create policy feature_flags_admin_v5 on public.feature_flags for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists site_themes_read_v5 on public.site_themes;
create policy site_themes_read_v5 on public.site_themes for select to anon,authenticated
using (status='published' or public.is_admin());
drop policy if exists site_themes_admin_v5 on public.site_themes;
create policy site_themes_admin_v5 on public.site_themes for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists badges_public_v5 on public.badges;
create policy badges_public_v5 on public.badges for select to anon,authenticated using (active=true or public.is_admin());
drop policy if exists badges_admin_v5 on public.badges;
create policy badges_admin_v5 on public.badges for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists profile_badges_public_v5 on public.profile_badges;
create policy profile_badges_public_v5 on public.profile_badges for select to anon,authenticated using (true);
drop policy if exists profile_badges_admin_v5 on public.profile_badges;
create policy profile_badges_admin_v5 on public.profile_badges for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists legal_active_read_v5 on public.legal_documents;
create policy legal_active_read_v5 on public.legal_documents for select to anon,authenticated using (active=true or public.is_admin());
drop policy if exists legal_admin_v5 on public.legal_documents;
create policy legal_admin_v5 on public.legal_documents for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists consents_self_v5 on public.user_consents;
create policy consents_self_v5 on public.user_consents for all to authenticated
using (user_id=auth.uid() or public.is_admin())
with check (user_id=auth.uid() or public.is_admin());

drop policy if exists follows_public_v5 on public.follows;
create policy follows_public_v5 on public.follows for select to anon,authenticated using (true);
drop policy if exists follows_self_v5 on public.follows;
create policy follows_self_v5 on public.follows for insert to authenticated with check (follower_id=auth.uid());
drop policy if exists follows_self_delete_v5 on public.follows;
create policy follows_self_delete_v5 on public.follows for delete to authenticated using (follower_id=auth.uid() or public.is_admin());

drop policy if exists blocks_self_v5 on public.user_blocks;
create policy blocks_self_v5 on public.user_blocks for all to authenticated
using (blocker_id=auth.uid() or public.is_admin())
with check (blocker_id=auth.uid() or public.is_admin());

drop policy if exists recommendation_self_v5 on public.recommendation_preferences;
create policy recommendation_self_v5 on public.recommendation_preferences for all to authenticated
using (user_id=auth.uid() or public.is_admin())
with check (user_id=auth.uid() or public.is_admin());

-- Vue admin compatible V5.
-- DROP/CREATE est volontaire : PostgreSQL refuse CREATE OR REPLACE VIEW
-- lorsque l'ordre ou le nom des colonnes existantes change.
drop view if exists public.admin_users;
create view public.admin_users
with (security_invoker=true)
as
select
  p.user_id as id,
  p.name,
  p.role,
  p.roles,
  p.is_admin,
  p.initials,
  p.verified,
  p.password_change_required,
  p.created_at,
  null::text as email
from public.profiles p;

revoke all on public.admin_users from anon,public;
grant select on public.admin_users to authenticated;

-- Publication Realtime pour les nouveaux écrans V5.
do $$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='reservations') then
      alter publication supabase_realtime add table public.reservations;
    end if;
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='reservation_events') then
      alter publication supabase_realtime add table public.reservation_events;
    end if;
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='beat_waitlist') then
      alter publication supabase_realtime add table public.beat_waitlist;
    end if;
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='feature_flags') then
      alter publication supabase_realtime add table public.feature_flags;
    end if;
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='site_settings') then
      alter publication supabase_realtime add table public.site_settings;
    end if;
  end if;
end $$;

insert into public.drsx_schema_migrations(version,description)
values('5.0.0-phase1','Fondations V5 : rôles multiples, réservations 48 h, liste d’attente, audit, Aspect et sécurité')
on conflict (version) do nothing;

commit;

-- -----------------------------------------------------------------------------
-- 7. Planification automatique (facultative mais recommandée)
-- L’échec de pg_cron n’annule pas la migration principale.
-- -----------------------------------------------------------------------------

do $$
begin
  begin
    execute 'create extension if not exists pg_cron with schema extensions';
  exception when others then
    raise notice 'pg_cron non activé automatiquement : %',sqlerrm;
  end;

  if to_regnamespace('cron') is not null then
    begin
      perform cron.unschedule(jobid)
      from cron.job
      where jobname in ('drsx-expire-reservations-v5','drsx-reservation-reminders-v5');
    exception when others then
      null;
    end;

    perform cron.schedule(
      'drsx-expire-reservations-v5',
      '*/15 * * * *',
      'select public.expire_reservations_v5();'
    );

    perform cron.schedule(
      'drsx-reservation-reminders-v5',
      '*/15 * * * *',
      'select public.send_reservation_reminders_v5();'
    );
  else
    raise notice 'Supabase Cron devra être activé depuis Integrations > Cron.';
  end if;
exception when others then
  raise notice 'Planification Cron à terminer manuellement : %',sqlerrm;
end $$;

-- Résultat de contrôle : une ligne doit apparaître.
select version,description,applied_at
from public.drsx_schema_migrations
where version='5.0.0-phase1';
