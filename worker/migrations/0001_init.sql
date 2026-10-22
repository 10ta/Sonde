-- 每个来源最新的一份上报
CREATE TABLE latest (
  source   TEXT PRIMARY KEY,          -- 如 traffic-bot、cdt-guard、cfst-ddns:cloudflare
  ts       INTEGER NOT NULL,          -- 上报方给的时间（秒）
  interval INTEGER NOT NULL,          -- 上报方声明的上报间隔（秒），超时没报就算离线
  data     TEXT NOT NULL,             -- 原样保存的 JSON
  received INTEGER NOT NULL           -- Worker 收到的时间（秒）
);

-- 曲线用的历史：每个来源每个指标每小时一个值（这一小时里最后一次上报的值）
CREATE TABLE history (
  source TEXT NOT NULL,
  key    TEXT NOT NULL,
  hour   INTEGER NOT NULL,            -- 整点的时间戳（秒）
  v      REAL NOT NULL,
  PRIMARY KEY (source, key, hour)
) WITHOUT ROWID;
CREATE INDEX history_hour ON history (hour);
