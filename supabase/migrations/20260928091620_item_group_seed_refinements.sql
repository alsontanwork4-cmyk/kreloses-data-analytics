-- Item-group seed rule refinements (follow-up to #9). Four seeded patterns were broader than meant:
--
--   1. "%spay%check%" / "%neuter%check%" (Consult) also caught an operation bundled with a check
--      ("Spay + pre-op check", "Spay incl. health check") → only the check itself is a consult now.
--   2. "surgery pack%" / "surgical pack%" / "surgery - pack%" (surgery, not an operation) also caught
--      "Surgery package" / "Surgical package" → only the pack itself (the whole name, or followed by a
--      space or "/").
--   3. "%foreign body%" (an operation) also caught "Eye foreign body flush" → flushing one out is
--      Hospital & treatment; a foreign body in an eye or ear is left unmapped for the owner.
--   4. "%cast%remov%", "%remov%stitch%" (and the other "<thing>…remov…" leave-unmapped rules) also
--      caught "Castration - cryptorchid (testicle removal)", "Mass removal with stitching" → only
--      removing the stitches / sutures / cast / drain / bandage / splint / tick itself is left
--      unmapped.
--
-- Defensive: only SEED rules are changed, each found by its exact match type and text
-- (`source = 'seed'`), never by id; rules the owner added and `item_assignments` are not touched. A
-- new rule is added only when no rule has the same match type and text (an owner's rule wins).
-- The cases are pinned in src/items/store.test.ts.
--
-- `item_classifications` is derived by the app's matcher (src/attribution/item-groups.ts), which
-- plain SQL cannot run, so this migration does not rewrite it: the Sync Engine recomputes every
-- item name under the current rules at the start of every run (`reclassifyAllItems`), so these
-- changes show from the next sync (or at once after any rule change in Settings → Items).

delete from public.item_group_rules r
using (values
  ('pattern', '%spay%check%'),
  ('pattern', '%neuter%check%'),
  ('pattern', 'surgery pack%'),
  ('pattern', 'surgical pack%'),
  ('pattern', 'surgery - pack%'),
  ('pattern', '%stitch%remov%'),
  ('pattern', '%remov%stitch%'),
  ('pattern', '%sutur%remov%'),
  ('pattern', '%remov%sutur%'),
  ('pattern', '%drain%remov%'),
  ('pattern', '%cast%remov%'),
  ('pattern', '%bandage%remov%'),
  ('pattern', '%splint%remov%'),
  ('pattern', '%tick%remov%')
) as old (match_type, pattern)
where r.source = 'seed' and r.match_type = old.match_type and r.pattern = old.pattern;

insert into public.item_group_rules
  (match_type, pattern, priority, mix_group, is_surgery, is_consult, is_vaccine, is_dental_scaling, is_procedure, source)
select r.match_type, r.pattern, r.priority, r.mix_group, r.is_surgery, r.is_consult, r.is_vaccine, r.is_dental_scaling, r.is_procedure, 'seed'
from (values
  -- 4. Leave unmapped: removing the thing itself (stitches, sutures, a cast, drain, bandage, splint, tick).
  ('pattern', '%stitch remov%',       99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%stitches remov%',     99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%stitching remov%',    99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%removal of stitch%',  99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%remove stitch%',      99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%suture remov%',       99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%sutures remov%',      99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%removal of sutur%',   99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%remove sutur%',       99, 'unmapped',              false, false, false, false, false),
  ('pattern', 'cast remov%',          99, 'unmapped',              false, false, false, false, false),
  ('pattern', '% cast remov%',        99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%removal of cast%',    99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%remove cast%',        99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%drain remov%',        99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%removal of drain%',   99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%bandage remov%',      99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%removal of bandage%', 99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%splint remov%',       99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%removal of splint%',  99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%tick remov%',         99, 'unmapped',              false, false, false, false, false),
  ('pattern', '%removal of tick%',    99, 'unmapped',              false, false, false, false, false),
  -- 1. Consult: the spay / neuter check itself (a bundle with the operation stays the operation).
  ('pattern', 'spay check%',          96, 'consult',               false, true,  false, false, false),
  ('pattern', '%spay recheck%',       96, 'consult',               false, true,  false, false, false),
  ('pattern', '%spay stitch%check%',  96, 'consult',               false, true,  false, false, false),
  ('pattern', '%spay wound check%',   96, 'consult',               false, true,  false, false, false),
  ('pattern', '%post%spay%check%',    96, 'consult',               false, true,  false, false, false),
  ('pattern', 'neuter check%',        96, 'consult',               false, true,  false, false, false),
  ('pattern', '%neuter recheck%',     96, 'consult',               false, true,  false, false, false),
  ('pattern', '%neuter stitch%check%', 96, 'consult',              false, true,  false, false, false),
  ('pattern', '%neuter wound check%', 96, 'consult',               false, true,  false, false, false),
  ('pattern', '%post%neuter%check%',  96, 'consult',               false, true,  false, false, false),
  -- 2. The surgical pack itself: surgery, not an operation ("Surgery package" is the SURGERY service).
  ('exact',   'surgery pack',         96, 'surgery',               true,  false, false, false, false),
  ('pattern', 'surgery pack %',       96, 'surgery',               true,  false, false, false, false),
  ('pattern', 'surgery pack/%',       96, 'surgery',               true,  false, false, false, false),
  ('exact',   'surgical pack',        96, 'surgery',               true,  false, false, false, false),
  ('pattern', 'surgical pack %',      96, 'surgery',               true,  false, false, false, false),
  ('pattern', 'surgical pack/%',      96, 'surgery',               true,  false, false, false, false),
  ('exact',   'surgery - pack',       96, 'surgery',               true,  false, false, false, false),
  ('pattern', 'surgery - pack %',     96, 'surgery',               true,  false, false, false, false),
  ('pattern', 'surgery - pack/%',     96, 'surgery',               true,  false, false, false, false),
  -- 3. Foreign bodies: flushing one out is treatment (94); one in an eye or ear is left unmapped (93);
  --    the rest stay operations ("%foreign body%", 92).
  ('pattern', '%foreign body%flush%', 94, 'hospital_treatment',    false, false, false, false, false),
  ('pattern', '%flush%foreign body%', 94, 'hospital_treatment',    false, false, false, false, false),
  ('pattern', 'eye foreign body%',    93, 'unmapped',              false, false, false, false, false),
  ('pattern', '% eye foreign body%',  93, 'unmapped',              false, false, false, false, false),
  ('pattern', 'ear foreign body%',    93, 'unmapped',              false, false, false, false, false),
  ('pattern', '% ear foreign body%',  93, 'unmapped',              false, false, false, false, false),
  ('pattern', '%foreign body%(eye)%', 93, 'unmapped',              false, false, false, false, false),
  ('pattern', '%foreign body%(ear)%', 93, 'unmapped',              false, false, false, false, false)
) as r (match_type, pattern, priority, mix_group, is_surgery, is_consult, is_vaccine, is_dental_scaling, is_procedure)
on conflict (match_type, pattern) do nothing;
