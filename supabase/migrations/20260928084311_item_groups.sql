-- Item groups (#9): which service-mix group each item sold belongs to, plus its surgery / consult /
-- vaccine / dental-scaling / procedure flags (spec stories 23–26, "Attribution & Rules").
--
--   item_group_rules      The rules: an exact item name or an ILIKE-style pattern → group + flags,
--                         with a priority. Seeded below; the owner adds/deletes rules in Settings → Items.
--   item_assignments      The owner's group + flags for ONE item (by normalised name). Beats every rule.
--   item_classifications  DERIVED: every item name seen on a sold invoice line → what the rules and
--                         assignments say it is NOW. Written only by src/items/store.ts with the pure
--                         matcher (src/attribution/item-groups.ts): recomputed for every name in the
--                         same transaction as any rule or assignment change, and filled in for new
--                         names in the transaction that stores an invoice's lines.
--
-- Groups and flags are never copied onto credited_lines: the Analytics Service joins
-- credited_lines → invoice_lines.item_name → item_classifications at query time, so changing a
-- rule or an assignment changes every figure, past periods included, at once (spec story 26;
-- ADR 0005 follows the same rule for staff).
--
-- Matching (see src/attribution/item-groups.ts): names and patterns are compared normalised
-- (Unicode NFKC, trimmed, inner whitespace collapsed, lower case). Precedence: assignment → exact
-- rules → pattern rules (by priority, highest first; ties to the lower id) → 'unmapped'. A rule
-- whose group is 'unmapped' means "leave unmapped": the first matching rule decides, so it keeps
-- lower rules from guessing. Pattern syntax = SQL ILIKE: % any run of characters, _ one character,
-- \ escapes.
--
-- Server-only like every app table: RLS on with no policies, API roles revoked.

create table public.item_group_rules (
  id bigint generated always as identity primary key,
  -- exact = the whole (normalised) name; pattern = ILIKE-style pattern on the normalised name.
  match_type text not null constraint item_group_rules_match_type_valid check (match_type in ('exact', 'pattern')),
  -- Stored normalised (lower case, whitespace collapsed) by the app.
  pattern text not null constraint item_group_rules_pattern_valid check (char_length(btrim(pattern)) between 1 and 200),
  -- Higher wins (among exact rules, and among pattern rules; an exact rule always beats a pattern).
  priority integer not null default 0 constraint item_group_rules_priority_valid check (priority between -10000 and 10000),
  -- One of the eight groups, or 'unmapped' = "leave unmapped" (matching items get no group; no flags).
  mix_group text not null constraint item_group_rules_mix_group_valid check (mix_group in (
    'consult', 'surgery', 'diagnostics', 'hospital_treatment', 'rehab_tcvm', 'medicines_supplements', 'preventive', 'retail_other',
    'unmapped'
  )),
  is_surgery boolean not null default false,
  is_consult boolean not null default false,
  is_vaccine boolean not null default false,
  is_dental_scaling boolean not null default false,
  -- An actual operation; false on sedation / anaesthesia-only charges. Always a surgery line.
  is_procedure boolean not null default false,
  -- seed = shipped with the app (this migration); owner = added in Settings → Items.
  source text not null default 'owner' constraint item_group_rules_source_valid check (source in ('seed', 'owner')),
  created_by text,
  created_at timestamptz not null default now(),
  constraint item_group_rules_procedure_is_surgery check (not is_procedure or is_surgery),
  constraint item_group_rules_unmapped_no_flags
    check (mix_group <> 'unmapped' or not (is_surgery or is_consult or is_vaccine or is_dental_scaling or is_procedure)),
  constraint item_group_rules_unique unique (match_type, pattern)
);

comment on table public.item_group_rules is
  'Item → service-mix group rules (exact name or ILIKE-style pattern, with a priority). Resolved by src/attribution/item-groups.ts.';

create table public.item_assignments (
  -- The item's normalised name (itemKey): NFKC, trimmed, whitespace collapsed, lower case.
  item_key text primary key constraint item_assignments_item_key_valid check (char_length(item_key) between 1 and 500),
  mix_group text not null constraint item_assignments_mix_group_valid check (mix_group in (
    'consult', 'surgery', 'diagnostics', 'hospital_treatment', 'rehab_tcvm', 'medicines_supplements', 'preventive', 'retail_other'
  )),
  is_surgery boolean not null default false,
  is_consult boolean not null default false,
  is_vaccine boolean not null default false,
  is_dental_scaling boolean not null default false,
  is_procedure boolean not null default false,
  assigned_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint item_assignments_procedure_is_surgery check (not is_procedure or is_surgery)
);

comment on table public.item_assignments is
  'The owner''s service-mix group + flags for one item (Settings → Items). Beats every item_group_rules row.';

create trigger set_updated_at before update on public.item_assignments
  for each row execute function public.set_updated_at();

create table public.item_classifications (
  -- The item name exactly as on invoice_lines.item_name (the join key).
  item_name text primary key,
  -- Its normalised name (itemKey): spelling variants of one item share it.
  item_key text not null,
  -- The group now, or 'unmapped' (no assignment, no rule matches).
  mix_group text not null constraint item_classifications_mix_group_valid check (mix_group in (
    'consult', 'surgery', 'diagnostics', 'hospital_treatment', 'rehab_tcvm', 'medicines_supplements', 'preventive', 'retail_other',
    'unmapped'
  )),
  is_surgery boolean not null,
  is_consult boolean not null,
  is_vaccine boolean not null,
  is_dental_scaling boolean not null,
  is_procedure boolean not null,
  -- What decided it: the owner's assignment, a rule (rule_id), or nothing ('unmapped'; rule_id set
  -- when a "leave unmapped" rule decided it).
  source text not null constraint item_classifications_source_valid check (source in ('assignment', 'rule', 'unmapped')),
  rule_id bigint references public.item_group_rules (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint item_classifications_procedure_is_surgery check (not is_procedure or is_surgery),
  constraint item_classifications_unmapped check ((source = 'unmapped') = (mix_group = 'unmapped')),
  constraint item_classifications_unmapped_no_flags
    check (source <> 'unmapped' or not (is_surgery or is_consult or is_vaccine or is_dental_scaling or is_procedure))
);

create index item_classifications_item_key_idx on public.item_classifications (item_key);
create index item_classifications_rule_id_idx on public.item_classifications (rule_id);
-- Sold lines by name: the Settings list and the recompute read the distinct names.
create index invoice_lines_item_name_idx on public.invoice_lines (item_name) where item_type <> 55;

comment on table public.item_classifications is
  'Derived: each item name seen on sold lines → its group and flags under the current rules/assignments. Written only by src/items/store.ts.';

create trigger set_updated_at before update on public.item_classifications
  for each row execute function public.set_updated_at();

alter table public.item_group_rules enable row level security;
alter table public.item_assignments enable row level security;
alter table public.item_classifications enable row level security;
revoke all on table public.item_group_rules, public.item_assignments, public.item_classifications from anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Seed rules, from the spec's definitions ("Metric definitions": Surgery, Consult) plus common
-- veterinary item names for the other groups. The owner's original hand-built rules are NOT
-- available, so these are a conservative starting point: an item they do not recognise stays
-- 'unmapped' (a visible bucket, listed in Settings → Items by revenue) rather than being guessed
-- into a wrong group — a wrong group (worse: a wrong "operation") is worse than unmapped. The
-- cases they are checked against are pinned in src/items/store.test.ts. Priorities:
--
--   99 leave unmapped: cancellation fees; removing stitches / sutures / a drain, cast, bandage,
--      splint or tick — never surgery / an operation
--   98 consult: any name with "consult" ("Spay consult", "Vaccination & consultation") and the
--      TCVM examination — a consult line, never an operation
--   96 specific exceptions to the broad patterns below: post-op visits (surgery follow-up /
--      recheck / review, post-op check / visit / review, spay or neuter check, wound check,
--      check-up) are consults; pre-anaesthetic tests and heartworm tests are diagnostics;
--      heartworm treatment is treatment; a dental scaling under anaesthesia stays dental scaling
--      (Preventive, not a surgery line); anaesthetic drops / creams are medicines; a flea comb and
--      vaccine paperwork (card, certificate, book, record) are retail; a surgical pack /
--      consumables is a surgery line but not an operation. A generic follow-up or recheck ("Follow-up
--      X-ray", "Recheck blood test") keeps its own group; a generic review stays unmapped (95).
--   92 operations named by what is removed: mass, tumour, lump, foreign body
--   91 named operations and the SURGERY service (surgery + operation)
--   90 sedation / anaesthesia (surgery, not an operation — "Sedation for X-ray" too, per the spec;
--      #15 counts a case with only such lines as "sedation only")
--   80 preventive · 60 diagnostics, rehab & TCVM · 50 hospital & treatment · 40 medicines &
--      supplements · 30 retail & other. Owner rules default to 100.
insert into public.item_group_rules
  (match_type, pattern, priority, mix_group, is_surgery, is_consult, is_vaccine, is_dental_scaling, is_procedure, source)
select r.match_type, r.pattern, r.priority, r.mix_group, r.is_surgery, r.is_consult, r.is_vaccine, r.is_dental_scaling, r.is_procedure, 'seed'
from (values
  -- Leave unmapped (no group, no flags).
  ('pattern', '%cancel%',             99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%stitch%remov%',       99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%remov%stitch%',       99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%sutur%remov%',        99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%remov%sutur%',        99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%drain%remov%',        99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%cast%remov%',         99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%bandage%remov%',      99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%splint%remov%',       99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%tick%remov%',         99, 'unmapped',              false, false, false, false, false),
  -- Consult: CONSULTATION services and the TCVM examination.
  ('pattern', '%consult%',            98, 'consult',               false, true,  false, false, false),
  ('pattern', '%tcvm exam%',          98, 'consult',               false, true,  false, false, false),
  -- Exceptions: post-op visits and check-ups are consults, never an operation. (Only post-op / consult
  -- wording: "Follow-up X-ray" or "Recheck blood test" keep their own group.)
  ('pattern', '%surg%follow%',        96, 'consult',               false, true,  false, false, false),
  ('pattern', '%surg%recheck%',       96, 'consult',               false, true,  false, false, false),
  ('pattern', '%surg%re-check%',      96, 'consult',               false, true,  false, false, false),
  ('pattern', '%surg%review%',        96, 'consult',               false, true,  false, false, false),
  ('pattern', '%post%op%check%',      96, 'consult',               false, true,  false, false, false),
  ('pattern', '%post%op%visit%',      96, 'consult',               false, true,  false, false, false),
  ('pattern', '%post%op%review%',     96, 'consult',               false, true,  false, false, false),
  ('pattern', '%spay%check%',         96, 'consult',               false, true,  false, false, false),
  ('pattern', '%neuter%check%',       96, 'consult',               false, true,  false, false, false),
  ('pattern', '%wound check%',        96, 'consult',               false, true,  false, false, false),
  ('pattern', '%check-up%',           96, 'consult',               false, true,  false, false, false),
  ('pattern', '%check up%',           96, 'consult',               false, true,  false, false, false),
  ('pattern', '%checkup%',            96, 'consult',               false, true,  false, false, false),
  -- A generic review (e.g. "Medication review") has no safe group: leave it unmapped.
  ('pattern', '%review%',             95, 'unmapped',              false, false, false, false, false),
  -- Exceptions: tests before an anaesthetic, and heartworm tests, are diagnostics.
  ('pattern', '%pre-anaes%',          96, 'diagnostics',           false, false, false, false, false),
  ('pattern', '%pre-anes%',           96, 'diagnostics',           false, false, false, false, false),
  ('pattern', '%pre anaes%',          96, 'diagnostics',           false, false, false, false, false),
  ('pattern', '%pre anes%',           96, 'diagnostics',           false, false, false, false, false),
  ('pattern', '%preanaes%',           96, 'diagnostics',           false, false, false, false, false),
  ('pattern', '%preanes%',            96, 'diagnostics',           false, false, false, false, false),
  ('pattern', '%heartworm%test%',     96, 'diagnostics',           false, false, false, false, false),
  -- Exceptions: heartworm treatment is treatment (not prevention).
  ('pattern', '%heartworm%treat%',    96, 'hospital_treatment',    false, false, false, false, false),
  -- Exceptions: a dental scaling under anaesthesia / sedation is still dental scaling (Preventive).
  ('pattern', '%scaling%anaes%',      96, 'preventive',            false, false, false, true,  false),
  ('pattern', '%scaling%anes%',       96, 'preventive',            false, false, false, true,  false),
  ('pattern', '%scaling%sedat%',      96, 'preventive',            false, false, false, true,  false),
  -- Exceptions: drops, creams and gels (anaesthetic ones too) are medicines.
  ('pattern', '%eye drop%',           96, 'medicines_supplements', false, false, false, false, false),
  ('pattern', '%ear drop%',           96, 'medicines_supplements', false, false, false, false, false),
  ('pattern', '%anaes%cream%',        96, 'medicines_supplements', false, false, false, false, false),
  ('pattern', '%anes%cream%',         96, 'medicines_supplements', false, false, false, false, false),
  ('pattern', '%anaes%gel%',          96, 'medicines_supplements', false, false, false, false, false),
  ('pattern', '%anes%gel%',           96, 'medicines_supplements', false, false, false, false, false),
  -- Exceptions: a flea comb and vaccine paperwork are retail, not prevention / a vaccination.
  ('pattern', '%flea comb%',          96, 'retail_other',          false, false, false, false, false),
  ('pattern', '%vaccine card%',       96, 'retail_other',          false, false, false, false, false),
  ('pattern', '%vaccination card%',   96, 'retail_other',          false, false, false, false, false),
  ('pattern', '%vaccine certificate%', 96, 'retail_other',         false, false, false, false, false),
  ('pattern', '%vaccination certificate%', 96, 'retail_other',     false, false, false, false, false),
  ('pattern', '%vaccine book%',       96, 'retail_other',          false, false, false, false, false),
  ('pattern', '%vaccination book%',   96, 'retail_other',          false, false, false, false, false),
  ('pattern', '%vaccine record%',     96, 'retail_other',          false, false, false, false, false),
  ('pattern', '%vaccination record%', 96, 'retail_other',          false, false, false, false, false),
  -- Exceptions: a surgical pack / consumables (the pack itself, not "Surgery - Spay package") is a
  -- related surgical charge, not an operation.
  ('pattern', 'surgery pack%',        96, 'surgery',               true,  false, false, false, false),
  ('pattern', 'surgical pack%',       96, 'surgery',               true,  false, false, false, false),
  ('pattern', 'surgery - pack%',      96, 'surgery',               true,  false, false, false, false),
  ('pattern', '%surgical consumable%', 96, 'surgery',              true,  false, false, false, false),
  ('pattern', '%surgery consumable%', 96, 'surgery',               true,  false, false, false, false),
  -- Operations named by what is removed (above the generic surgery rules).
  ('pattern', '%mass removal%',       92, 'surgery',               true,  false, false, false, true),
  ('pattern', '%tumour removal%',     92, 'surgery',               true,  false, false, false, true),
  ('pattern', '%tumor removal%',      92, 'surgery',               true,  false, false, false, true),
  ('pattern', '%lump removal%',       92, 'surgery',               true,  false, false, false, true),
  ('pattern', '%foreign body%',       92, 'surgery',               true,  false, false, false, true),
  -- Surgery: the SURGERY service and named operations (actual procedures).
  ('exact',   'surgery',              91, 'surgery',               true,  false, false, false, true),
  ('pattern', 'surgery %',            91, 'surgery',               true,  false, false, false, true),
  ('pattern', 'surgery-%',            91, 'surgery',               true,  false, false, false, true),
  ('pattern', 'surgery:%',            91, 'surgery',               true,  false, false, false, true),
  ('pattern', '%spay%',               91, 'surgery',               true,  false, false, false, true),
  ('pattern', '%neuter%',             91, 'surgery',               true,  false, false, false, true),
  ('pattern', '%castration%',         91, 'surgery',               true,  false, false, false, true),
  ('pattern', '%ovariohysterectomy%', 91, 'surgery',               true,  false, false, false, true),
  ('pattern', '%cryoablation%',       91, 'surgery',               true,  false, false, false, true),
  ('pattern', '%cryosurgery%',        91, 'surgery',               true,  false, false, false, true),
  ('pattern', '%cystotomy%',          91, 'surgery',               true,  false, false, false, true),
  ('pattern', '%tooth extraction%',   91, 'surgery',               true,  false, false, false, true),
  ('pattern', '%teeth extraction%',   91, 'surgery',               true,  false, false, false, true),
  ('pattern', '%dental extraction%',  91, 'surgery',               true,  false, false, false, true),
  ('pattern', '%pyometra%',           91, 'surgery',               true,  false, false, false, true),
  ('pattern', 'c-section%',           91, 'surgery',               true,  false, false, false, true),
  ('pattern', '% c-section%',         91, 'surgery',               true,  false, false, false, true),
  ('pattern', 'c section%',           91, 'surgery',               true,  false, false, false, true),
  ('pattern', '% c section%',         91, 'surgery',               true,  false, false, false, true),
  ('pattern', '%caesarean%',          91, 'surgery',               true,  false, false, false, true),
  ('pattern', '%cesarean%',           91, 'surgery',               true,  false, false, false, true),
  ('pattern', 'fho%',                 91, 'surgery',               true,  false, false, false, true),
  ('pattern', '% fho%',               91, 'surgery',               true,  false, false, false, true),
  ('pattern', '%femoral head%',       91, 'surgery',               true,  false, false, false, true),
  ('pattern', '%hernia repair%',      91, 'surgery',               true,  false, false, false, true),
  ('pattern', '%herniorrhaphy%',      91, 'surgery',               true,  false, false, false, true),
  ('pattern', '%closed reduction%',   91, 'surgery',               true,  false, false, false, true),
  ('pattern', '%wound stitch%',       91, 'surgery',               true,  false, false, false, true),
  ('pattern', '%wound sutur%',        91, 'surgery',               true,  false, false, false, true),
  ('pattern', '%stitching%',          91, 'surgery',               true,  false, false, false, true),
  ('pattern', '%surgical fee%',       91, 'surgery',               true,  false, false, false, true),
  -- Surgery: sedation / anaesthesia charges — surgery lines, but not an operation by themselves.
  ('pattern', '%sedation%',           90, 'surgery',               true,  false, false, false, false),
  ('pattern', '%anaesthe%',           90, 'surgery',               true,  false, false, false, false),
  ('pattern', '%anesthe%',            90, 'surgery',               true,  false, false, false, false),
  -- Preventive: vaccines, parasite control, dental scaling.
  ('pattern', '%vaccin%',             80, 'preventive',            false, false, true,  false, false),
  ('pattern', '%deworm%',             80, 'preventive',            false, false, false, false, false),
  ('pattern', '%de-worm%',            80, 'preventive',            false, false, false, false, false),
  ('pattern', '%worming%',            80, 'preventive',            false, false, false, false, false),
  ('pattern', '%flea%',               80, 'preventive',            false, false, false, false, false),
  ('pattern', 'tick %',               80, 'preventive',            false, false, false, false, false),
  ('pattern', '% tick %',             80, 'preventive',            false, false, false, false, false),
  ('pattern', '% tick',               80, 'preventive',            false, false, false, false, false),
  ('pattern', '%heartworm%',          80, 'preventive',            false, false, false, false, false),
  ('pattern', '%seresto%',            80, 'preventive',            false, false, false, false, false),
  ('pattern', '%scaling%',            80, 'preventive',            false, false, false, true,  false),
  ('pattern', '%scale and polish%',   80, 'preventive',            false, false, false, true,  false),
  ('pattern', '%scale & polish%',     80, 'preventive',            false, false, false, true,  false),
  -- Diagnostics.
  ('pattern', '%blood test%',         60, 'diagnostics',           false, false, false, false, false),
  ('pattern', '%blood panel%',        60, 'diagnostics',           false, false, false, false, false),
  ('pattern', '%haematology%',        60, 'diagnostics',           false, false, false, false, false),
  ('pattern', '%hematology%',         60, 'diagnostics',           false, false, false, false, false),
  ('pattern', '%biochem%',            60, 'diagnostics',           false, false, false, false, false),
  ('pattern', '%x-ray%',              60, 'diagnostics',           false, false, false, false, false),
  ('pattern', '%xray%',               60, 'diagnostics',           false, false, false, false, false),
  ('pattern', '%x ray%',              60, 'diagnostics',           false, false, false, false, false),
  ('pattern', '%radiograph%',         60, 'diagnostics',           false, false, false, false, false),
  ('pattern', '%ultrasound%',         60, 'diagnostics',           false, false, false, false, false),
  ('pattern', '%urinalysis%',         60, 'diagnostics',           false, false, false, false, false),
  ('pattern', '%urine test%',         60, 'diagnostics',           false, false, false, false, false),
  ('pattern', '%cytology%',           60, 'diagnostics',           false, false, false, false, false),
  ('pattern', '%laboratory%',         60, 'diagnostics',           false, false, false, false, false),
  ('pattern', '%lab test%',           60, 'diagnostics',           false, false, false, false, false),
  ('pattern', '%lab fee%',            60, 'diagnostics',           false, false, false, false, false),
  -- Rehab & TCVM.
  ('pattern', '%acupuncture%',        60, 'rehab_tcvm',            false, false, false, false, false),
  ('pattern', '%physio%',             60, 'rehab_tcvm',            false, false, false, false, false),
  ('pattern', '%hydrotherapy%',       60, 'rehab_tcvm',            false, false, false, false, false),
  ('pattern', '%laser therapy%',      60, 'rehab_tcvm',            false, false, false, false, false),
  ('pattern', '%laser treat%',        60, 'rehab_tcvm',            false, false, false, false, false),
  ('pattern', '%rehab%',              60, 'rehab_tcvm',            false, false, false, false, false),
  ('pattern', '%tcvm%',               60, 'rehab_tcvm',            false, false, false, false, false),
  ('pattern', '%chinese herb%',       60, 'rehab_tcvm',            false, false, false, false, false),
  ('pattern', '%herbal medicine%',    60, 'rehab_tcvm',            false, false, false, false, false),
  ('pattern', '%herbal formula%',     60, 'rehab_tcvm',            false, false, false, false, false),
  ('pattern', '%tui na%',             60, 'rehab_tcvm',            false, false, false, false, false),
  ('pattern', '%underwater treadmill%', 60, 'rehab_tcvm',          false, false, false, false, false),
  -- Hospital & treatment.
  ('pattern', '%hospitalisation%',    50, 'hospital_treatment',    false, false, false, false, false),
  ('pattern', '%hospitalization%',    50, 'hospital_treatment',    false, false, false, false, false),
  ('pattern', '%inpatient%',          50, 'hospital_treatment',    false, false, false, false, false),
  ('pattern', '%in-patient%',         50, 'hospital_treatment',    false, false, false, false, false),
  ('pattern', 'ward %',               50, 'hospital_treatment',    false, false, false, false, false),
  ('pattern', '% ward %',             50, 'hospital_treatment',    false, false, false, false, false),
  ('pattern', '% ward',               50, 'hospital_treatment',    false, false, false, false, false),
  ('pattern', '%medical boarding%',   50, 'hospital_treatment',    false, false, false, false, false),
  ('pattern', '%iv fluid%',           50, 'hospital_treatment',    false, false, false, false, false),
  ('pattern', '%fluid therapy%',      50, 'hospital_treatment',    false, false, false, false, false),
  ('pattern', '%injection%',          50, 'hospital_treatment',    false, false, false, false, false),
  ('pattern', '%treatment%',          50, 'hospital_treatment',    false, false, false, false, false),
  ('pattern', '%nursing%',            50, 'hospital_treatment',    false, false, false, false, false),
  ('pattern', '%wound dressing%',     50, 'hospital_treatment',    false, false, false, false, false),
  -- Medicines & supplements (product lines; eye / ear drops are exceptions above).
  ('pattern', '%tablet%',             40, 'medicines_supplements', false, false, false, false, false),
  ('pattern', '%capsule%',            40, 'medicines_supplements', false, false, false, false, false),
  ('pattern', '%syrup%',              40, 'medicines_supplements', false, false, false, false, false),
  ('pattern', '%suspension%',         40, 'medicines_supplements', false, false, false, false, false),
  ('pattern', '%antibiotic%',         40, 'medicines_supplements', false, false, false, false, false),
  ('pattern', '%ointment%',           40, 'medicines_supplements', false, false, false, false, false),
  ('pattern', '%supplement%',         40, 'medicines_supplements', false, false, false, false, false),
  ('pattern', '%probiotic%',          40, 'medicines_supplements', false, false, false, false, false),
  ('pattern', '%vitamin%',            40, 'medicines_supplements', false, false, false, false, false),
  ('pattern', '%medication%',         40, 'medicines_supplements', false, false, false, false, false),
  ('pattern', '%medicated%',          40, 'medicines_supplements', false, false, false, false, false),
  -- Retail & other: food, accessories, grooming.
  ('pattern', '%food%',               30, 'retail_other',          false, false, false, false, false),
  ('pattern', '%prescription diet%',  30, 'retail_other',          false, false, false, false, false),
  ('pattern', '%kibble%',             30, 'retail_other',          false, false, false, false, false),
  ('pattern', '%treats%',             30, 'retail_other',          false, false, false, false, false),
  ('pattern', 'toy%',                 30, 'retail_other',          false, false, false, false, false),
  ('pattern', '% toy%',               30, 'retail_other',          false, false, false, false, false),
  ('pattern', '%collar%',             30, 'retail_other',          false, false, false, false, false),
  ('pattern', '%leash%',              30, 'retail_other',          false, false, false, false, false),
  ('pattern', '%harness%',            30, 'retail_other',          false, false, false, false, false),
  ('pattern', '%shampoo%',            30, 'retail_other',          false, false, false, false, false),
  ('pattern', '%grooming%',           30, 'retail_other',          false, false, false, false, false),
  ('pattern', '%nail clip%',          30, 'retail_other',          false, false, false, false, false),
  ('pattern', '%nail trim%',          30, 'retail_other',          false, false, false, false, false),
  ('pattern', '%bath%',               30, 'retail_other',          false, false, false, false, false),
  ('pattern', '%litter%',             30, 'retail_other',          false, false, false, false, false),
  ('pattern', '%accessor%',           30, 'retail_other',          false, false, false, false, false)
) as r (match_type, pattern, priority, mix_group, is_surgery, is_consult, is_vaccine, is_dental_scaling, is_procedure);
