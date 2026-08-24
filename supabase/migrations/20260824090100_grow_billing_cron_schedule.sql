-- Replaces the Cardcom daily billing job with the same schedule pointed at
-- grow-billing-cron. See that function's own top-of-file comment: this must
-- be unscheduled (cron.unschedule('grow-daily-billing')) if it turns out
-- Grow's own "Premium Recurring Payment" already charges saved tokens on
-- its own schedule -- otherwise every subscriber gets charged twice.
select cron.unschedule('cardcom-daily-billing');

-- The header value below is not a payment credential -- it only stops a
-- stray extra POST to grow-billing-cron from wasting a request. It cannot
-- be used to double-charge anyone: the function claims each subscription
-- atomically (current_period_end is pushed forward before the card is
-- charged), so a second concurrent call finds nothing left due. That's also
-- why this is safe to commit to a public repo -- rotating it later just
-- means editing this literal and GROW_CRON_SECRET together in a follow-up
-- migration.
select cron.schedule(
  'grow-daily-billing',
  '0 3 * * *',
  $cron$
  select net.http_post(
    url := 'https://kgkdkkqoebnpahvetwzk.supabase.co/functions/v1/grow-billing-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-grow-cron-secret', 'bff365ac9361b9ca6949b9dc850026f9a0b853fb7eb2a0ed'
    ),
    body := '{}'::jsonb
  );
  $cron$
);
