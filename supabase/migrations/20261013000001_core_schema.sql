-- BTBG Digital Platform: core schema (Release 1)
-- Traceability: SRS v1.0 section 3.10 (data model) and 4.10 (status models).
--
-- The Node API is the only client of this schema. It connects with the
-- database connection string (postgres role) and enforces RBAC itself.
-- Row level security is enabled on every table at the end of this file with
-- no policies, so the Supabase anon/authenticated keys cannot read anything
-- through PostgREST.

-- Uses only core Postgres (15+) features: gen_random_uuid(), sha256(), unique nulls not distinct.

-- ---------------------------------------------------------------------------
-- Reference data (NFR-LOC-02)
-- ---------------------------------------------------------------------------
create table dzongkhags (
  id    serial primary key,
  name  text not null unique
);

create table gewogs (
  id            serial primary key,
  dzongkhag_id  int  not null references dzongkhags(id),
  name          text not null,
  kind          text not null default 'gewog' check (kind in ('gewog','thromde')),
  unique (dzongkhag_id, name)
);

create table sectors (
  code  text primary key,
  name  text not null
);

create table skills (
  id           serial primary key,
  name         text not null unique,
  sector_code  text references sectors(code)
);

-- ---------------------------------------------------------------------------
-- Identity, access and consent (FR-AUTH-*, FR-ADM-13)
-- ---------------------------------------------------------------------------
create table users (
  id                     uuid primary key default gen_random_uuid(),
  mobile                 text not null unique,
  email                  text,
  password_hash          text,
  full_name              text not null,
  mfa_enabled            boolean not null default false,
  status                 text not null default 'active' check (status in ('pending','active','suspended')),
  suspended_reason       text,
  language               text not null default 'en' check (language in ('en','dz')),
  mobile_verified_at     timestamptz,
  contact_confirmed_at   timestamptz,
  failed_login_attempts  int not null default 0,
  locked_until           timestamptz,
  last_login_at          timestamptz,
  signup_viewer_ref      text,
  created_by             uuid references users(id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create unique index users_email_unique on users (lower(email)) where email is not null;

create table roles (
  code         text primary key,
  name         text not null,
  is_internal  boolean not null default false,
  org_scoped   boolean not null default false,
  description  text
);

create table role_permissions (
  role_code   text not null references roles(code) on delete cascade,
  permission  text not null,
  primary key (role_code, permission)
);

create table user_roles (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  role_code   text not null references roles(code),
  org_id      uuid,
  granted_by  uuid references users(id),
  created_at  timestamptz not null default now(),
  unique nulls not distinct (user_id, role_code, org_id)
);

create table sessions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  active_role    text not null references roles(code),
  active_org_id  uuid,
  mfa_passed     boolean not null default false,
  idle_timeout_s int not null,
  ip             text,
  user_agent     text,
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  revoked_at     timestamptz
);
create index sessions_user_idx on sessions(user_id);

create table otp_codes (
  id           uuid primary key default gen_random_uuid(),
  mobile       text not null,
  user_id      uuid references users(id) on delete cascade,
  purpose      text not null,
  ref_id       uuid,
  code_hash    text not null,
  attempts     int not null default 0,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index otp_lookup_idx on otp_codes(mobile, purpose, created_at desc);

create table password_reset_tokens (
  token_hash  text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  expires_at  timestamptz not null,
  used_at     timestamptz
);

create table consents (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  version      text not null,
  scope        text[] not null,
  accepted_at  timestamptz not null default now(),
  ip           text
);

-- ---------------------------------------------------------------------------
-- Host organisations (FR-EMP-01..05, FR-ENT-01..05)
-- ---------------------------------------------------------------------------
create table organisations (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  trade_licence_no     text not null unique,
  sector_code          text not null references sectors(code),
  star_rating          smallint check (star_rating between 1 and 5),
  dzongkhag_id         int references dzongkhags(id),
  gewog_id             int references gewogs(id),
  address              text,
  owner_name           text,
  owner_cid_enc        text,
  size_tier            text not null default 'small' check (size_tier in ('micro','small','medium','large')),
  staff_count          int,
  peak_months          int[] not null default '{}',
  off_peak_months      int[] not null default '{}',
  culture              text,
  values_text          text,
  photos               text[] not null default '{}',
  compliance_needs     text,
  verification_status  text not null default 'pending' check (verification_status in ('pending','verified','rejected')),
  verified_by          uuid references users(id),
  verified_at          timestamptz,
  status               text not null default 'active' check (status in ('active','suspended')),
  suspended_reason     text,
  created_by           uuid references users(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table user_roles add constraint user_roles_org_fk foreign key (org_id) references organisations(id) on delete cascade;

create table org_documents (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations(id) on delete cascade,
  kind         text not null,
  file_path    text not null,
  file_name    text,
  uploaded_by  uuid references users(id),
  created_at   timestamptz not null default now()
);

-- Verification decisions and profile change history (FR-ENT-05)
create table verification_decisions (
  id           uuid primary key default gen_random_uuid(),
  entity_type  text not null,
  entity_id    uuid not null,
  item         text not null,
  decision     text not null check (decision in ('verified','pending','rejected')),
  reason       text,
  decided_by   uuid references users(id),
  created_at   timestamptz not null default now()
);
create index verification_decisions_entity_idx on verification_decisions(entity_type, entity_id);

create table change_history (
  id           bigserial primary key,
  entity_type  text not null,
  entity_id    uuid not null,
  changed_by   uuid references users(id),
  changes      jsonb not null,
  created_at   timestamptz not null default now()
);
create index change_history_entity_idx on change_history(entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Video campaign careers (referenced by people and vacancies)
-- ---------------------------------------------------------------------------
create table careers (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique,
  title            text not null,
  sector_code      text references sectors(code),
  summary          text,
  daily_tasks      text,
  skills           text[] not null default '{}',
  training_routes  text,
  wage_min         numeric(12,2),
  wage_max         numeric(12,2),
  growth_path      text,
  role_keywords    text[] not null default '{}',
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- People: job seekers, apprentices, alumni (FR-EE-*, FR-CND-*)
-- ---------------------------------------------------------------------------
create table person_profiles (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid unique references users(id) on delete set null,
  full_name              text not null,
  mobile                 text not null unique,
  email                  text,
  cid_enc                text,
  cid_hash               text unique,
  cid_last4              text,
  date_of_birth          date,
  gender                 text check (gender in ('female','male','other','prefer_not')),
  dzongkhag_id           int references dzongkhags(id),
  gewog_id               int references gewogs(id),
  village                text,
  alt_contact_name       text,
  alt_contact_mobile     text,
  alt_contact_relation   text,
  expected_wage          numeric(12,2),
  available_from         date,
  employment_type        text not null default 'full_time' check (employment_type in ('full_time','freelance')),
  preferred_roles        text[] not null default '{}',
  preferred_dzongkhags   int[] not null default '{}',
  languages              text[] not null default '{}',
  willing_to_relocate    boolean,
  bio                    text,
  preferred_career_id    uuid references careers(id),
  stage                  text not null default 'registered' check (stage in
    ('registered','contacted','screening','screened','training','ready','placed','not_suitable','withdrawn')),
  lifecycle              text not null default 'job_seeker' check (lifecycle in ('job_seeker','apprentice','alumni')),
  source                 text not null default 'self' check (source in
    ('self','tti','college','desuung','gyalsung','dzongkhag','walk_in','social_media','referral','field_officer')),
  source_detail          text,
  assigned_officer_id    uuid references users(id),
  last_contact_at        timestamptz,
  failed_contact_attempts int not null default 0,
  contact_unverified     boolean not null default false,
  identity_status        text not null default 'pending' check (identity_status in ('pending','verified','rejected')),
  bank_name              text,
  bank_account_enc       text,
  bank_account_last4     text,
  bank_account_holder    text,
  nudged_at              timestamptz,
  created_by             uuid references users(id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index person_stage_idx on person_profiles(stage);
create index person_dz_idx on person_profiles(dzongkhag_id);

create table person_credentials (
  id                   uuid primary key default gen_random_uuid(),
  person_id            uuid not null references person_profiles(id) on delete cascade,
  type                 text not null check (type in ('school','tvet','university','certificate')),
  institution          text not null,
  qualification        text,
  year                 int,
  file_path            text,
  verification_status  text not null default 'pending' check (verification_status in ('pending','verified','rejected')),
  verified_by          uuid references users(id),
  verified_at          timestamptz,
  created_at           timestamptz not null default now()
);

create table person_skills (
  person_id  uuid not null references person_profiles(id) on delete cascade,
  skill_id   int  not null references skills(id),
  level      smallint not null default 2 check (level between 1 and 5),
  primary key (person_id, skill_id)
);

create table work_history (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references person_profiles(id) on delete cascade,
  employer    text not null,
  role        text not null,
  start_date  date,
  end_date    date,
  description text
);

create table portfolio_media (
  id                uuid primary key default gen_random_uuid(),
  person_id         uuid not null references person_profiles(id) on delete cascade,
  kind              text not null check (kind in ('photo','video','document')),
  file_path         text not null,
  caption           text,
  duration_seconds  int check (duration_seconds is null or duration_seconds <= 60),
  created_at        timestamptz not null default now()
);

create table candidate_stage_history (
  id          bigserial primary key,
  person_id   uuid not null references person_profiles(id) on delete cascade,
  from_stage  text,
  to_stage    text not null,
  reason      text,
  changed_by  uuid references users(id),
  created_at  timestamptz not null default now()
);

create table contact_log (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references person_profiles(id) on delete cascade,
  officer_id  uuid references users(id),
  channel     text not null check (channel in ('phone','sms','visit','email','alt_contact')),
  outcome     text not null check (outcome in ('reached','no_answer','wrong_number','alt_contact_reached')),
  notes       text,
  created_at  timestamptz not null default now()
);

-- Screening (FR-CND-04/05)
create table screening_scorecards (
  id              uuid primary key default gen_random_uuid(),
  sector_code     text not null references sectors(code),
  version         int  not null,
  name            text not null,
  criteria        jsonb not null,
  pass_threshold  numeric(5,2) not null,
  is_active       boolean not null default true,
  created_by      uuid references users(id),
  created_at      timestamptz not null default now(),
  unique (sector_code, version)
);

create table screening_results (
  id                  uuid primary key default gen_random_uuid(),
  person_id           uuid not null references person_profiles(id) on delete cascade,
  scorecard_id        uuid not null references screening_scorecards(id),
  scores              jsonb not null,
  total               numeric(5,2) not null,
  passed              boolean not null,
  wage_expectation    numeric(12,2),
  willing_to_relocate boolean,
  commitment_months   int,
  notes               text,
  officer_id          uuid references users(id),
  created_at          timestamptz not null default now()
);

-- Training (FR-CND-07)
create table training_records (
  id              uuid primary key default gen_random_uuid(),
  person_id       uuid not null references person_profiles(id) on delete cascade,
  programme       text not null,
  provider        text not null,
  start_date      date,
  end_date        date,
  attendance_pct  numeric(5,2) check (attendance_pct between 0 and 100),
  assessment      text,
  result          text not null default 'in_progress' check (result in ('in_progress','passed','failed')),
  recorded_by     uuid references users(id),
  created_at      timestamptz not null default now()
);

create table training_programmes (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  provider     text not null,
  career_id    uuid references careers(id) on delete set null,
  sector_code  text references sectors(code),
  dzongkhag_id int references dzongkhags(id),
  description  text,
  start_date   date,
  link         text,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Vacancies and applications (FR-EMP-10..23, FR-EE-10..16, FR-PLC-01..03)
-- ---------------------------------------------------------------------------
create table vacancies (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references organisations(id),
  title                text not null,
  department           text,
  career_id            uuid references careers(id),
  sector_code          text not null references sectors(code),
  openings             int not null check (openings > 0),
  filled               int not null default 0,
  experience_required  text,
  first_time_friendly  boolean not null default true,
  dzongkhag_id         int references dzongkhags(id),
  gewog_id             int references gewogs(id),
  location_text        text,
  wage                 numeric(12,2) not null,
  accommodation        boolean not null default false,
  meals                boolean not null default false,
  benefits             text,
  shift_pattern        text,
  hours_per_week       numeric(5,2),
  start_date           date,
  is_seasonal          boolean not null default false,
  season_start         date,
  season_end           date,
  description          text,
  status               text not null default 'draft' check (status in
    ('draft','submitted','approved','open','paused','filled','closed')),
  review_comment       text,
  submitted_at         timestamptz,
  approved_at          timestamptz,
  approved_by          uuid references users(id),
  opened_at            timestamptz,
  share_slug           text unique,
  created_by           uuid references users(id),
  created_on_behalf    boolean not null default false,
  host_confirmed_at    timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (not is_seasonal or (season_start is not null and season_end is not null and season_end >= season_start))
);
create index vacancies_status_idx on vacancies(status);
create index vacancies_org_idx on vacancies(org_id);

create table vacancy_skills (
  vacancy_id  uuid not null references vacancies(id) on delete cascade,
  skill_id    int  not null references skills(id),
  primary key (vacancy_id, skill_id)
);

create table vacancy_status_history (
  id          bigserial primary key,
  vacancy_id  uuid not null references vacancies(id) on delete cascade,
  from_status text,
  to_status   text not null,
  comment     text,
  changed_by  uuid references users(id),
  created_at  timestamptz not null default now()
);

create table applications (
  id                    uuid primary key default gen_random_uuid(),
  vacancy_id            uuid not null references vacancies(id) on delete cascade,
  person_id             uuid not null references person_profiles(id) on delete cascade,
  stage                 text not null default 'applied' check (stage in
    ('applied','screening','shortlisted','interview','offered','hired','not_selected','withdrawn')),
  source                text not null default 'applied' check (source in ('applied','matched','imported')),
  match_score           numeric(5,2),
  shared_with_host_at   timestamptz,
  shared_by             uuid references users(id),
  host_decision         text check (host_decision in ('accepted','declined')),
  host_decision_reason  text,
  outcome_reason        text,
  outcome_notified_at   timestamptz,
  offer_wage            numeric(12,2),
  offer_start_date      date,
  applied_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (vacancy_id, person_id)
);

create table interviews (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references applications(id) on delete cascade,
  scheduled_at    timestamptz not null,
  location        text,
  mode            text not null default 'in_person' check (mode in ('in_person','phone','video')),
  status          text not null default 'scheduled' check (status in ('scheduled','completed','cancelled','no_show')),
  result          text check (result in ('pass','fail')),
  notes           text,
  reminder_sent   boolean not null default false,
  booked_by       uuid references users(id),
  created_at      timestamptz not null default now()
);

create table saved_vacancies (
  person_id   uuid not null references person_profiles(id) on delete cascade,
  vacancy_id  uuid not null references vacancies(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (person_id, vacancy_id)
);

create table job_alerts (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references person_profiles(id) on delete cascade,
  criteria    jsonb not null,
  last_sent_at timestamptz,
  created_at  timestamptz not null default now()
);

create table match_decisions (
  id          uuid primary key default gen_random_uuid(),
  vacancy_id  uuid not null references vacancies(id) on delete cascade,
  person_id   uuid not null references person_profiles(id) on delete cascade,
  score       numeric(5,2),
  breakdown   jsonb,
  decision    text not null check (decision in ('shared','rejected')),
  reason      text not null,
  decided_by  uuid references users(id),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Employer of Record: contracts, HPAs, placements (FR-PLC-10..27)
-- ---------------------------------------------------------------------------
create table fee_rules (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  size_tier            text check (size_tier in ('micro','small','medium','large')),
  sector_code          text references sectors(code),
  role_keyword         text,
  min_months           int,
  max_months           int,
  placement_fee        numeric(12,2) not null default 0,
  monthly_service_fee  numeric(12,2) not null default 0,
  admin_fee_pct        numeric(5,2) not null default 0,
  admin_fee_fixed      numeric(12,2) not null default 0,
  priority             int not null default 100,
  active               boolean not null default true,
  created_at           timestamptz not null default now()
);

create table employment_contracts (
  id                   uuid primary key default gen_random_uuid(),
  person_id            uuid not null references person_profiles(id),
  status               text not null default 'draft' check (status in ('draft','sent','signed','active','bench','ended')),
  wage                 numeric(12,2) not null,
  pay_frequency        text not null default 'monthly',
  hours_per_week       numeric(5,2) not null,
  days_per_week        int not null,
  rest_days_per_week   int not null,
  leave_days_per_year  int not null,
  start_date           date not null,
  end_date             date not null,
  version              int not null default 1,
  signed_at            timestamptz,
  ended_at             timestamptz,
  end_reason           text,
  created_by           uuid references users(id),
  created_at           timestamptz not null default now()
);
-- One live employment contract per person at a time.
create unique index one_live_contract_per_person on employment_contracts(person_id)
  where status in ('draft','sent','signed','active','bench');

create table host_placement_agreements (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references organisations(id),
  fee_rule_id               uuid references fee_rules(id),
  placement_fee             numeric(12,2) not null default 0,
  monthly_service_fee       numeric(12,2) not null default 0,
  admin_fee_pct             numeric(5,2) not null default 0,
  admin_fee_fixed           numeric(12,2) not null default 0,
  placement_fee_invoiced    boolean not null default false,
  replacement_entitlement   int not null default 1,
  replacements_used         int not null default 0,
  replacement_period_days   int not null default 90,
  start_date                date not null,
  end_date                  date not null,
  status                    text not null default 'draft' check (status in ('draft','sent','signed','active','ended')),
  version                   int not null default 1,
  signed_at                 timestamptz,
  signed_by                 uuid references users(id),
  ended_at                  timestamptz,
  end_reason                text,
  created_by                uuid references users(id),
  created_at                timestamptz not null default now()
);

-- Every generated version of a contract or HPA, locked once signed (FR-PLC-13)
create table agreement_documents (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('employment_contract','hpa')),
  agreement_id    uuid not null,
  version         int not null,
  content         jsonb not null,
  body_text       text not null,
  file_path       text,
  sha256          text,
  status          text not null default 'pending_signature' check (status in ('pending_signature','signed','superseded')),
  signed_by       uuid references users(id),
  signed_at       timestamptz,
  signer_ip       text,
  created_at      timestamptz not null default now(),
  unique (kind, agreement_id, version)
);

create table placements (
  id                 uuid primary key default gen_random_uuid(),
  contract_id        uuid references employment_contracts(id),
  hpa_id             uuid references host_placement_agreements(id),
  person_id          uuid not null references person_profiles(id),
  org_id             uuid not null references organisations(id),
  vacancy_id         uuid references vacancies(id),
  application_id     uuid references applications(id),
  officer_id         uuid references users(id),
  supervisor_user_id uuid references users(id),
  role_title         text not null,
  wage               numeric(12,2) not null,
  start_date         date not null,
  planned_end_date   date not null,
  actual_end_date    date,
  status             text not null default 'proposed' check (status in
    ('proposed','interview','offered','contracted','active','ending','ended','converted')),
  end_reason_code    text check (end_reason_code in ('host_decision','apprentice_request','btbg_monitoring','other')),
  end_reason_text    text,
  outcome            text check (outcome in ('conversion','move','exit')),
  outcome_reason     text,
  outcome_at         timestamptz,
  direct_hire_wage   numeric(12,2),
  direct_hire_date   date,
  replacement_applied boolean not null default false,
  sign_reminder_sent boolean not null default false,
  created_by         uuid references users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index placements_status_idx on placements(status);
create index placements_org_idx on placements(org_id);
create index placements_person_idx on placements(person_id);

create table placement_status_history (
  id            bigserial primary key,
  placement_id  uuid not null references placements(id) on delete cascade,
  from_status   text,
  to_status     text not null,
  reason        text,
  changed_by    uuid references users(id),
  created_at    timestamptz not null default now()
);

-- Requests from host or apprentice (FR-EMP-33/34, FR-EE-24, Workflow 4)
create table placement_requests (
  id                   uuid primary key default gen_random_uuid(),
  placement_id         uuid not null references placements(id) on delete cascade,
  kind                 text not null check (kind in ('conversation','warning','move','end','conversion')),
  requester_party      text not null check (requester_party in ('host','apprentice','officer')),
  requested_by         uuid references users(id),
  reason_code          text check (reason_code in ('host_decision','apprentice_request','btbg_monitoring','other')),
  reason               text not null,
  direct_hire_wage     numeric(12,2),
  direct_hire_date     date,
  status               text not null default 'pending' check (status in ('pending','approved','rejected')),
  grievance_signoff_by uuid references users(id),
  grievance_signoff_at timestamptz,
  decided_by           uuid references users(id),
  decided_at           timestamptz,
  decision_note        text,
  created_at           timestamptz not null default now()
);

create table checkins (
  id            uuid primary key default gen_random_uuid(),
  placement_id  uuid not null references placements(id) on delete cascade,
  day           int  not null,
  party         text not null check (party in ('apprentice','host')),
  due_date      date not null,
  form_data     jsonb,
  risk_rating   text check (risk_rating in ('green','amber','red')),
  completed_at  timestamptz,
  completed_by  uuid references users(id),
  unique (placement_id, day, party)
);

create table bench_periods (
  id                     uuid primary key default gen_random_uuid(),
  contract_id            uuid not null references employment_contracts(id),
  previous_placement_id  uuid references placements(id),
  start_date             date not null,
  deadline               date not null,
  ended_at               timestamptz,
  end_reason             text,
  pay_rule               jsonb not null,
  alerted_50             boolean not null default false,
  alerted_80             boolean not null default false,
  escalated              boolean not null default false,
  created_at             timestamptz not null default now()
);

create table attendance (
  id               uuid primary key default gen_random_uuid(),
  placement_id     uuid not null references placements(id) on delete cascade,
  period           text not null check (period ~ '^\d{4}-\d{2}$'),
  scheduled_days   int  not null,
  absence_dates    date[] not null default '{}',
  paid_leave_days  int  not null default 0,
  days_worked      numeric(5,2) not null,
  confirmed_by     uuid references users(id),
  confirmed_at     timestamptz,
  defaulted        boolean not null default false,
  unique (placement_id, period)
);

create table performance_notes (
  id             uuid primary key default gen_random_uuid(),
  placement_id   uuid not null references placements(id) on delete cascade,
  author_id      uuid references users(id),
  note           text,
  punctuality    smallint check (punctuality between 1 and 5),
  skills         smallint check (skills between 1 and 5),
  attitude       smallint check (attitude between 1 and 5),
  teamwork       smallint check (teamwork between 1 and 5),
  customer_care  smallint check (customer_care between 1 and 5),
  created_at     timestamptz not null default now()
);

create table certificates (
  id                 uuid primary key default gen_random_uuid(),
  person_id          uuid not null references person_profiles(id),
  placement_id       uuid references placements(id),
  kind               text not null default 'btbg_programme' check (kind in ('btbg_programme','training')),
  title              text not null,
  programme          text not null,
  outcome            text,
  nc_mapping         text,
  verification_code  text not null unique,
  issued_at          timestamptz not null default now(),
  issued_by          uuid references users(id),
  revoked_at         timestamptz
);

-- Follow-up tasks for staff (risk panel, Red check-ins, sourcing, etc.)
create table tasks (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null,
  title          text not null,
  description    text,
  entity_type    text,
  entity_id      uuid,
  assignee_id    uuid references users(id),
  assignee_role  text references roles(code),
  priority       text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  due_at         timestamptz,
  status         text not null default 'open' check (status in ('open','done','cancelled')),
  dedupe_key     text unique,
  completed_by   uuid references users(id),
  completed_at   timestamptz,
  created_at     timestamptz not null default now()
);
create index tasks_open_idx on tasks(status, assignee_role);

-- ---------------------------------------------------------------------------
-- Payroll (FR-PAY-*)
-- ---------------------------------------------------------------------------
create table payroll_runs (
  id            uuid primary key default gen_random_uuid(),
  period        text not null unique check (period ~ '^\d{4}-\d{2}$'),
  pay_date      date not null,
  status        text not null default 'draft' check (status in ('draft','submitted','approved','paid','closed')),
  total_gross   numeric(14,2) not null default 0,
  total_net     numeric(14,2) not null default 0,
  line_count    int not null default 0,
  flagged_count int not null default 0,
  prepared_by   uuid references users(id),
  submitted_at  timestamptz,
  approved_by   uuid references users(id),
  approved_at   timestamptz,
  paid_at       timestamptz,
  created_at    timestamptz not null default now(),
  check (approved_by is null or approved_by <> prepared_by)
);

create table payslips (
  id                 uuid primary key default gen_random_uuid(),
  run_id             uuid not null references payroll_runs(id) on delete cascade,
  person_id          uuid not null references person_profiles(id),
  contract_id        uuid not null references employment_contracts(id),
  monthly_wage       numeric(12,2) not null,
  scheduled_days     int not null,
  days_worked        numeric(5,2) not null,
  bench_days         numeric(5,2) not null default 0,
  paid_leave_days    numeric(5,2) not null default 0,
  gross              numeric(12,2) not null,
  total_deductions   numeric(12,2) not null default 0,
  total_adjustments  numeric(12,2) not null default 0,
  net                numeric(12,2) not null,
  flagged            boolean not null default false,
  flag_reasons       text[] not null default '{}',
  bank_status        text not null default 'pending' check (bank_status in ('pending','paid','rejected')),
  bank_reject_reason text,
  published_at       timestamptz,
  unique (run_id, contract_id)
);

create table payslip_lines (
  id          uuid primary key default gen_random_uuid(),
  payslip_id  uuid not null references payslips(id) on delete cascade,
  kind        text not null check (kind in ('earning','deduction','adjustment')),
  label       text not null,
  amount      numeric(12,2) not null
);

create table payroll_adjustments (
  id                 uuid primary key default gen_random_uuid(),
  person_id          uuid not null references person_profiles(id),
  amount             numeric(12,2) not null,
  reason             text not null,
  source_payslip_id  uuid references payslips(id),
  applied_run_id     uuid references payroll_runs(id),
  created_by         uuid references users(id),
  created_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Billing (FR-ACC-*)
-- ---------------------------------------------------------------------------
create sequence invoice_number_seq start 1001;

create table invoices (
  id               uuid primary key default gen_random_uuid(),
  number           text not null unique,
  org_id           uuid not null references organisations(id),
  period           text not null check (period ~ '^\d{4}-\d{2}$'),
  issue_date       date,
  due_date         date,
  subtotal         numeric(14,2) not null default 0,
  credits          numeric(14,2) not null default 0,
  total            numeric(14,2) not null default 0,
  amount_paid      numeric(14,2) not null default 0,
  status           text not null default 'draft' check (status in ('draft','issued','part_paid','paid','overdue','written_off')),
  reminder_days    int[] not null default '{}',
  created_by       uuid references users(id),
  created_at       timestamptz not null default now(),
  unique (org_id, period)
);

create table invoice_lines (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references invoices(id) on delete cascade,
  hpa_id        uuid references host_placement_agreements(id),
  placement_id  uuid references placements(id),
  line_type     text not null check (line_type in ('wage','service','admin','credit')),
  description   text not null,
  amount        numeric(12,2) not null
);

create table payments (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations(id),
  amount       numeric(14,2) not null check (amount > 0),
  method       text not null check (method in ('bank_transfer','cash','cheque')),
  reference    text,
  received_on  date not null,
  recorded_by  uuid references users(id),
  created_at   timestamptz not null default now()
);

create table payment_allocations (
  payment_id  uuid not null references payments(id) on delete cascade,
  invoice_id  uuid not null references invoices(id),
  amount      numeric(14,2) not null check (amount > 0),
  primary key (payment_id, invoice_id)
);

-- ---------------------------------------------------------------------------
-- Ratings (FR-EMP-40/41, FR-EE-30..32)
-- ---------------------------------------------------------------------------
create table ratings (
  id               uuid primary key default gen_random_uuid(),
  placement_id     uuid references placements(id) on delete cascade,
  checkin_id       uuid references checkins(id),
  from_party       text not null check (from_party in ('host','apprentice')),
  from_user_id     uuid references users(id),
  to_party         text not null check (to_party in ('apprentice','host','btbg')),
  org_id           uuid references organisations(id),
  person_id        uuid references person_profiles(id),
  context          text not null check (context in ('checkin','placement_end','quarterly')),
  stars            smallint not null check (stars between 1 and 5),
  criteria_scores  jsonb not null default '{}',
  comment          text,
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Grievances (FR-FDB-*, FR-EE-40..44)
-- ---------------------------------------------------------------------------
create sequence grievance_ref_seq start 1;
create sequence ticket_ref_seq start 1;

create table helpdesk_tickets (
  id                 uuid primary key default gen_random_uuid(),
  ref                text not null unique,
  user_id            uuid references users(id),
  contact_name       text,
  contact_mobile     text,
  contact_email      text,
  category           text not null check (category in ('account','technical','payment','placement','other')),
  priority           text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  subject            text not null,
  status             text not null default 'open' check (status in ('open','in_progress','awaiting_user','resolved','closed','converted')),
  assignee_id        uuid references users(id),
  response_due       timestamptz not null,
  resolution_due     timestamptz not null,
  first_response_at  timestamptz,
  resolved_at        timestamptz,
  closed_at          timestamptz,
  response_breach_alerted   boolean not null default false,
  resolution_breach_alerted boolean not null default false,
  satisfaction       smallint check (satisfaction between 1 and 5),
  grievance_id       uuid,
  page_url           text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table ticket_messages (
  id           uuid primary key default gen_random_uuid(),
  ticket_id    uuid not null references helpdesk_tickets(id) on delete cascade,
  author_id    uuid references users(id),
  author_kind  text not null check (author_kind in ('user','agent','system')),
  body         text not null,
  created_at   timestamptz not null default now()
);

create table grievances (
  id                     uuid primary key default gen_random_uuid(),
  ref                    text not null unique,
  complainant_user_id    uuid references users(id),
  complainant_person_id  uuid references person_profiles(id),
  complainant_party      text not null check (complainant_party in ('apprentice','job_seeker','host','other')),
  complainant_name       text,
  complainant_mobile     text,
  against_org_id         uuid references organisations(id),
  placement_id           uuid references placements(id),
  ticket_id              uuid references helpdesk_tickets(id),
  channel                text not null check (channel in ('app','sms','phone','helpdesk')),
  category               text not null check (category in ('pay','safety','harassment','working_hours','conduct','contract','other')),
  severity               smallint not null check (severity between 1 and 3),
  subject                text not null,
  description_enc        text not null,
  share_identity         boolean not null default false,
  anti_retaliation       boolean not null default true,
  status                 text not null default 'new' check (status in
    ('new','assigned','under_review','resolution_proposed','resolved','escalated','referred','closed')),
  officer_id             uuid references users(id),
  target_date            timestamptz not null,
  first_contact_due      timestamptz not null,
  first_contact_at       timestamptz,
  resolution_type        text check (resolution_type in ('no_action','mediation','corrective_action','redeployment','other')),
  resolution_text        text,
  complainant_response   text check (complainant_response in ('accepted','rejected')),
  escalation_level       smallint not null default 0,
  legal_referral         boolean not null default false,
  satisfaction           smallint check (satisfaction between 1 and 5),
  closed_at              timestamptz,
  created_by             uuid references users(id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index grievances_status_idx on grievances(status);

alter table helpdesk_tickets add constraint tickets_grievance_fk foreign key (grievance_id) references grievances(id);

create table grievance_actions (
  id            uuid primary key default gen_random_uuid(),
  grievance_id  uuid not null references grievances(id) on delete cascade,
  actor_id      uuid references users(id),
  action        text not null,
  note_enc      text,
  visible_to_complainant boolean not null default false,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Vocational Video Campaign (FR-VID-*)
-- ---------------------------------------------------------------------------
create table tags (
  id    serial primary key,
  slug  text not null unique,
  name  text not null
);

create table videos (
  id                uuid primary key default gen_random_uuid(),
  career_id         uuid not null references careers(id),
  title             text not null,
  description       text,
  kind              text not null default 'short' check (kind in ('short','long')),
  duration_seconds  int check (duration_seconds is null or duration_seconds <= 1200),
  language          text not null default 'dz',
  status            text not null default 'idea' check (status in
    ('idea','filming','editing','review','consent_confirmed','scheduled','published','archived')),
  original_path     text,
  renditions        jsonb not null default '{}',
  thumbnail_path    text,
  subtitles         jsonb not null default '{}',
  processing_status text not null default 'none' check (processing_status in ('none','processing','ready','failed')),
  processing_error  text,
  review_comment    text,
  scheduled_at      timestamptz,
  published_at      timestamptz,
  unpublish_due_at  timestamptz,
  unpublished_reason text,
  created_by        uuid references users(id),
  reviewed_by       uuid references users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table video_tags (
  video_id  uuid not null references videos(id) on delete cascade,
  tag_id    int  not null references tags(id),
  primary key (video_id, tag_id)
);

create table video_featured_people (
  id                     uuid primary key default gen_random_uuid(),
  video_id               uuid not null references videos(id) on delete cascade,
  name                   text not null,
  role_title             text,
  is_minor               boolean not null default false,
  consent_file           text,
  guardian_name          text,
  guardian_consent_file  text,
  consent_status         text not null default 'pending' check (consent_status in ('pending','confirmed','withdrawn')),
  withdrawn_at           timestamptz,
  withdrawal_reason      text,
  created_at             timestamptz not null default now()
);

create table video_questions (
  id                 uuid primary key default gen_random_uuid(),
  video_id           uuid not null references videos(id) on delete cascade,
  user_id            uuid not null references users(id),
  body               text not null,
  answer             text,
  answered_by        uuid references users(id),
  answered_at        timestamptz,
  moderation_status  text not null default 'pending' check (moderation_status in ('pending','approved','rejected')),
  profanity_flag     boolean not null default false,
  report_count       int not null default 0,
  created_at         timestamptz not null default now()
);

create table video_question_reports (
  question_id  uuid not null references video_questions(id) on delete cascade,
  reporter_ref text not null,
  reason       text,
  created_at   timestamptz not null default now(),
  primary key (question_id, reporter_ref)
);

create table saved_videos (
  user_id     uuid not null references users(id) on delete cascade,
  video_id    uuid not null references videos(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, video_id)
);

create table video_events (
  id             bigserial primary key,
  video_id       uuid references videos(id) on delete cascade,
  career_id      uuid references careers(id) on delete cascade,
  viewer_ref     text not null,
  user_id        uuid references users(id),
  type           text not null check (type in ('view','progress','complete','share','career_visit','register_click')),
  watch_seconds  int not null default 0,
  created_at     timestamptz not null default now()
);
create index video_events_video_idx on video_events(video_id, type);
create index video_events_viewer_idx on video_events(viewer_ref);

-- ---------------------------------------------------------------------------
-- Notifications (FR-NOT-*)
-- ---------------------------------------------------------------------------
create table notification_templates (
  code      text not null,
  channel   text not null check (channel in ('in_app','sms','email')),
  language  text not null check (language in ('en','dz')),
  subject   text,
  body      text not null,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  primary key (code, channel, language)
);

create table notification_preferences (
  user_id  uuid primary key references users(id) on delete cascade,
  sms      boolean not null default true,
  email    boolean not null default true,
  in_app   boolean not null default true
);

create table notifications (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references users(id) on delete cascade,
  channel        text not null check (channel in ('in_app','sms','email')),
  to_address     text,
  template_code  text,
  subject        text,
  body           text not null,
  link           text,
  status         text not null default 'queued' check (status in ('queued','sent','delivered','failed','read')),
  attempts       int not null default 0,
  last_error     text,
  provider_ref   text,
  read_at        timestamptz,
  sent_at        timestamptz,
  created_at     timestamptz not null default now()
);
create index notifications_user_idx on notifications(user_id, channel, created_at desc);
create index notifications_retry_idx on notifications(status, channel) where status = 'failed';

-- ---------------------------------------------------------------------------
-- Configuration and audit (FR-ADM-10..13)
-- ---------------------------------------------------------------------------
create table config_settings (
  key          text primary key,
  value        jsonb not null,
  description  text,
  updated_by   uuid references users(id),
  updated_at   timestamptz not null default now()
);

create table config_history (
  id          bigserial primary key,
  key         text not null,
  old_value   jsonb,
  new_value   jsonb not null,
  changed_by  uuid references users(id),
  created_at  timestamptz not null default now()
);

-- Tamper-evident audit log: every row carries sha256(prev_hash || payload).
create table audit_log (
  id           bigserial primary key,
  actor_id     uuid,
  action       text not null,
  entity_type  text,
  entity_id    text,
  ip           text,
  details      jsonb not null default '{}',
  prev_hash    text not null,
  hash         text not null,
  created_at   timestamptz not null default now()
);

create or replace function audit_log_hash() returns trigger language plpgsql as $$
declare
  last_hash text;
begin
  -- Serialise writers so the hash chain never forks.
  perform pg_advisory_xact_lock(4242001);
  -- Take the id only after the lock, so id order always matches chain order.
  new.id := nextval(pg_get_serial_sequence('audit_log', 'id'));
  select hash into last_hash from audit_log order by id desc limit 1;
  new.prev_hash := coalesce(last_hash, repeat('0', 64));
  new.created_at := coalesce(new.created_at, now());
  new.hash := encode(sha256(convert_to(
    new.prev_hash || '|' || coalesce(new.actor_id::text, '') || '|' || new.action || '|' ||
    coalesce(new.entity_type, '') || '|' || coalesce(new.entity_id, '') || '|' ||
    new.details::text || '|' || to_char(new.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    'UTF8')), 'hex');
  return new;
end $$;

create trigger audit_log_hash_trg before insert on audit_log
  for each row execute function audit_log_hash();

create or replace function audit_log_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;

create trigger audit_log_no_update before update or delete on audit_log
  for each row execute function audit_log_immutable();

-- Closed payroll is never edited (FR-PAY-10).
create or replace function payslip_lock_guard() returns trigger language plpgsql as $$
declare
  run_status text;
begin
  select status into run_status from payroll_runs
   where id = coalesce(new.run_id, old.run_id);
  if run_status in ('approved','paid','closed') then
    -- Only bank status / publish markers may change after approval.
    if tg_op = 'UPDATE' and new.gross = old.gross and new.net = old.net
       and new.total_deductions = old.total_deductions and new.total_adjustments = old.total_adjustments
       and new.days_worked = old.days_worked then
      return new;
    end if;
    raise exception 'payroll run % is locked', run_status;
  end if;
  return coalesce(new, old);
end $$;

create trigger payslip_lock before update or delete on payslips
  for each row execute function payslip_lock_guard();

-- updated_at maintenance
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['users','organisations','person_profiles','vacancies','applications',
                           'placements','helpdesk_tickets','grievances','videos'] loop
    execute format('create trigger %I_touch before update on %I for each row execute function touch_updated_at()', t, t);
  end loop;
end $$;

-- Deny-all RLS: the API uses the service connection; PostgREST clients get nothing.
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', r.tablename);
  end loop;
end $$;
