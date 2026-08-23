-- Cardcom has no hosted subscription object to remind us to charge someone
-- again -- this is what fills that gap: once a day, ask cardcom-billing-cron
-- to charge every account whose current_period_end has passed.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- The header value below is not a payment credential -- it only stops a
-- stray extra POST to cardcom-billing-cron from wasting a request. It
-- cannot be used to double-charge anyone: the function claims each
-- subscription atomically (current_period_end is pushed forward before the
-- card is charged), so a second concurrent call finds nothing left due.
-- That's also why this is safe to commit to a public repo -- rotating it
-- later just means editing this literal and CARDCOM_CRON_SECRET together in
-- a follow-up migration.
select cron.schedule(
  'cardcom-daily-billing',
  '0 3 * * *',
  $cron$
  select net.http_post(
    url := 'https://kgkdkkqoebnpahvetwzk.supabase.co/functions/v1/cardcom-billing-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cardcom-cron-secret', '11c85b1c497986b440bd24b38c4f020aaf3c7f3fee10bfb7'
    ),
    body := '{}'::jsonb
  );
  $cron$
);
