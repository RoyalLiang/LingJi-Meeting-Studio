create table if not exists sessions (
  id uuid primary key,
  workspace_id text not null,
  folder_id text null,
  title text not null,
  status text not null,
  device_selection jsonb not null,
  config jsonb not null,
  created_at timestamptz not null default now(),
  started_at timestamptz null,
  ended_at timestamptz null
);

create table if not exists segments (
  segment_id uuid primary key,
  session_id uuid not null references sessions(id) on delete cascade,
  sequence integer not null,
  status text not null,
  source_language text not null,
  start_ms integer not null,
  end_ms integer not null,
  text text not null,
  confidence double precision null,
  speaker_id text null,
  provider text not null,
  glossary_hits text[] not null default '{}',
  received_at timestamptz not null
);

create index if not exists idx_segments_session_sequence
  on segments(session_id, sequence);

create table if not exists translations (
  session_id uuid not null references sessions(id) on delete cascade,
  segment_id uuid not null references segments(segment_id) on delete cascade,
  target_language text not null,
  text text not null,
  provider text not null,
  is_final boolean not null default false,
  primary key (segment_id, target_language)
);

create index if not exists idx_translations_session_segment
  on translations(session_id, segment_id);

create table if not exists share_links (
  id uuid primary key,
  session_id uuid not null references sessions(id) on delete cascade,
  token uuid not null unique,
  access text not null,
  expires_at timestamptz null,
  revoked_at timestamptz null
);

create index if not exists idx_share_links_session_id
  on share_links(session_id);

create table if not exists ai_summaries (
  session_id uuid primary key references sessions(id) on delete cascade,
  summary text not null,
  topics jsonb not null default '[]'::jsonb,
  action_items jsonb not null default '[]'::jsonb,
  generated_at timestamptz not null
);

create table if not exists session_audio_clips (
  audio_clip_id uuid primary key,
  session_id uuid not null references sessions(id) on delete cascade,
  segment_id uuid null,
  sequence integer not null,
  target_language text null,
  provider text not null,
  format text not null,
  mime_type text not null,
  byte_length integer not null,
  audio_data bytea not null,
  created_at timestamptz not null
);

create index if not exists idx_session_audio_clips_session_sequence
  on session_audio_clips(session_id, sequence, created_at);
