-- Report-email send ledger: one row per (ET date, slot), so a slot's report is
-- sent AT MOST ONCE per day no matter how many cron invocations reach the email
-- step. The primary key is the lock: the first invocation to INSERT claims the
-- slot; a concurrent/later one gets a PK violation (2627) and skips.
--
-- Why a claim row and not a "did we already send?" SELECT: on 2026-08-03 the
-- 21:00 sold-capture run took ~8 minutes, so a second ?sold=1 invocation reached
-- the email step while the first was still in flight — both saw "not sent yet"
-- and both mailed the full recipient list. Only an atomic insert closes that race.

IF OBJECT_ID('lqdt.report_sends', 'U') IS NULL
BEGIN
  CREATE TABLE lqdt.report_sends (
    send_date NVARCHAR(10) NOT NULL,   -- ET date key (YYYY-MM-DD)
    slot      NVARCHAR(16) NOT NULL,   -- 'noon' | 'evening'
    run_id    UNIQUEIDENTIFIER NULL,   -- the cron run that won the claim
    claimed_at DATETIME2(3) NOT NULL CONSTRAINT DF_report_sends_claimed DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_report_sends PRIMARY KEY (send_date, slot)
  );
END
GO
