-- Small coverage table avoids scanning the full sold_lots fact table before
-- every forecast/export read. Safe to run repeatedly.
IF OBJECT_ID('lqdt.sold_coverage', 'U') IS NULL
BEGIN
  CREATE TABLE lqdt.sold_coverage (
    close_date_et DATE NOT NULL CONSTRAINT PK_sold_coverage PRIMARY KEY,
    refreshed_at DATETIME2(3) NOT NULL CONSTRAINT DF_sold_coverage_refreshed DEFAULT SYSUTCDATETIME()
  );
END
GO

MERGE lqdt.sold_coverage AS T
USING (SELECT DISTINCT close_date_et FROM lqdt.sold_lots) AS S
  ON T.close_date_et = S.close_date_et
WHEN NOT MATCHED THEN
  INSERT (close_date_et) VALUES (S.close_date_et);
GO
