-- SN 不會有英文字母 O 與 I：O 視為數字 0、I 視為數字 1（決策 2026-10-26）
create or replace function app.norm_sn(p_sn text)
returns text language sql immutable as $$
  select nullif(translate(upper(regexp_replace(coalesce(p_sn, ''), '\s', '', 'g')), 'OI', '01'), '')
$$;
