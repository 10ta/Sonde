#!/usr/bin/env bash
# Sonde 一键部署（Worker + D1）
#
# 用法（在仓库根目录）：
#   ./init.sh                         首次：登录 Cloudflare → 建库 → 建表 → 部署 → 生成上报密钥 → 写入 web/config.js
#                                     再次：复用已保存的配置，等于「更新部署」（日常用 ./update.sh）
#   ./init.sh --url https://api.x.com 改用自定义域名作为 API 地址（先在 CF 控制台给 Worker 绑好域名）
#   ./init.sh --new-token             重新生成上报密钥（旧密钥立即失效，三个工具的配置都要改）
#
# 配置保存在仓库根目录的 .sonde.env（权限 600，已在 .gitignore 里），里面有上报密钥，不要提交。
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$ROOT/worker"
ENV_FILE="$ROOT/.sonde.env"
DB_NAME="sonde"

NEW_TOKEN=0 SET_URL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --new-token) NEW_TOKEN=1 ;;
    --url) SET_URL="${2:-}"; shift ;;
    --url=*) SET_URL="${1#--url=}" ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done

if [[ -t 1 ]]; then B=$'\e[1m' G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' N=$'\e[0m'; else B='' G='' Y='' R='' N=''; fi
step() { echo; echo "${B}==> $*${N}"; }
ok()   { echo "${G}✔${N} $*"; }
warn() { echo "${Y}!${N} $*"; }
die()  { echo "${R}✘ $*${N}" >&2; exit 1; }
ask()  { local v; read -r -p "$1" v; printf '%s' "$v"; }
ask_secret() { local v; read -r -s -p "$1" v; echo >&2; printf '%s' "$v"; }

cd "$WORKER_DIR" || die "找不到 worker 目录：$WORKER_DIR"
wr() { npx --no-install wrangler "$@"; }

# ---------- 0. 已保存的配置 ----------
INGEST_TOKEN="" WORKER_URL="" PUBLIC_URL="" SAVED_CF_TOKEN="" SAVED_CF_ACCOUNT=""
FIRST_RUN=1
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  FIRST_RUN=0
fi
[[ -n "$SAVED_CF_TOKEN" && -z "${CLOUDFLARE_API_TOKEN:-}" ]] && export CLOUDFLARE_API_TOKEN="$SAVED_CF_TOKEN"
[[ -n "$SAVED_CF_ACCOUNT" && -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]] && export CLOUDFLARE_ACCOUNT_ID="$SAVED_CF_ACCOUNT"
if [[ -n "$SET_URL" ]]; then
  [[ "$SET_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$ ]] || die "--url 应该是 https:// 开头的地址：$SET_URL"
  PUBLIC_URL="${SET_URL%/}"
fi

save_env() {
  local tmp; tmp="$(mktemp)"
  {
    echo "# Sonde 部署配置（由 init.sh 生成，含上报密钥，勿提交）"
    for k in INGEST_TOKEN WORKER_URL PUBLIC_URL SAVED_CF_TOKEN SAVED_CF_ACCOUNT; do printf '%s=%q\n' "$k" "${!k}"; done
  } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}
rand() { openssl rand -hex 24 2>/dev/null || node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"; }

# ---------- 1. 环境 ----------
step "检查环境"
command -v node >/dev/null || die "没有 node，请先安装 Node.js 20 或更新版本"
command -v npm  >/dev/null || die "没有 npm"
command -v curl >/dev/null || die "没有 curl"
(( $(node -p 'process.versions.node.split(".")[0]') >= 20 )) || die "Node.js 版本是 $(node -v)，需要 20 或更新"
ok "node $(node -v)"

if (( FIRST_RUN )); then
  cat <<EOF

${Y}部署前请确认：${N}
  · 会在你的 Cloudflare 账户里新建一个 Worker（sonde）和一个 D1 数据库（sonde）
  · 请求计入账户共享的每日 10 万次 Worker 请求额度（三个工具每天合计几百次上报，加上打开网页的读取）
  · 不使用 cron，不占账户的免费 cron 名额
EOF
  [[ "$(ask '继续？[Y/n] ')" =~ ^[Nn] ]] && exit 0
fi

if [[ ! -d node_modules/wrangler || package-lock.json -nt node_modules ]]; then
  step "安装依赖"
  if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund --loglevel=error; else npm install --no-audit --no-fund --loglevel=error; fi
  touch node_modules
fi
ok "wrangler $(wr --version 2>/dev/null | tail -1)"

# ---------- 2. Cloudflare 登录 ----------
step "检查 Cloudflare 登录"
logged_in() { wr whoami </dev/null 2>&1 | grep -qi "logged in"; }
if ! logged_in; then
  echo "还没有登录 Cloudflare，选择登录方式："
  echo "  1) 浏览器登录（本机有浏览器时）"
  echo "  2) API token（服务器 / 没有浏览器时）"
  case "$(ask '输入 1 或 2：')" in
    1) wr login ;;
    2)
      cat <<'EOF'
创建 token：https://dash.cloudflare.com/profile/api-tokens → Create Token
  → 模板选 "Edit Cloudflare Workers" → 权限里再加一行 "Account · D1 · Edit" → 创建
EOF
      CLOUDFLARE_API_TOKEN="$(ask_secret '粘贴 API token：')"; export CLOUDFLARE_API_TOKEN
      acct="$(ask 'Account ID（Workers & Pages 页面右侧可见；账户只有一个可直接回车）：')"
      [[ -n "$acct" ]] && export CLOUDFLARE_ACCOUNT_ID="$acct"
      if [[ "$(ask '把 token 保存到 .sonde.env 方便下次更新？[Y/n] ')" =~ ^[Nn] ]]; then
        SAVED_CF_TOKEN="" SAVED_CF_ACCOUNT=""
      else
        SAVED_CF_TOKEN="$CLOUDFLARE_API_TOKEN" SAVED_CF_ACCOUNT="${CLOUDFLARE_ACCOUNT_ID:-}"
      fi
      ;;
    *) die "已取消" ;;
  esac
  logged_in || die "登录失败。API token 方式请检查权限是否包含 Workers Scripts 和 D1"
fi
ok "已登录 Cloudflare"

# ---------- 3. D1 ----------
step "准备 D1 数据库"
d1_id() {
  wr d1 list --json </dev/null 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
      try {
        const j = JSON.parse(s.slice(s.indexOf("[")));
        const db = j.find((x) => x.name === process.argv[1]);
        process.stdout.write(db ? (db.uuid || db.database_id || "") : "");
      } catch { process.stdout.write(""); }
    });' "$DB_NAME"
}
DB_ID="$(d1_id)"
if [[ -z "$DB_ID" ]]; then
  wr d1 create "$DB_NAME" </dev/null >/dev/null
  DB_ID="$(d1_id)"
  [[ -n "$DB_ID" ]] || die "D1 创建后仍查不到，请在控制台 Storage & Databases → D1 确认"
  ok "已创建 D1：$DB_NAME"
else
  ok "D1 已存在：$DB_NAME"
fi
DB_ID="$DB_ID" node -e '
  const fs = require("fs"); const f = "wrangler.toml";
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^(database_id\s*=\s*).*$/m, `$1"${process.env.DB_ID}"`));'

MIG_OUT="$(wr d1 migrations apply "$DB_NAME" --remote </dev/null 2>&1)" || { echo "$MIG_OUT" | tail -20; die "数据库迁移失败"; }
if grep -q "No migrations to apply" <<<"$MIG_OUT"; then ok "表结构已是最新"; else ok "表结构已更新"; fi

# ---------- 4. 部署 ----------
step "部署 Worker"
set +e
DEPLOY_OUT="$(wr deploy </dev/null 2>&1)"; DEPLOY_RC=$?
set -e
echo "$DEPLOY_OUT" | sed 's/\x1b\[[0-9;]*m//g' | grep -vE "^\s*$|Proxy environment" | tail -12
if (( DEPLOY_RC != 0 )); then
  grep -qi "workers.dev" <<<"$DEPLOY_OUT" && warn "账户可能还没有 workers.dev 子域：控制台 Workers & Pages 里注册一个，然后重新运行 ./init.sh"
  die "部署失败，见上面的输出"
fi
url="$(grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' <<<"$DEPLOY_OUT" | head -1 || true)"
[[ -n "$url" ]] && WORKER_URL="$url"
API_URL="${PUBLIC_URL:-$WORKER_URL}"
[[ -n "$API_URL" ]] || die "没有从部署输出里找到 Worker 地址。给 Worker 绑好自定义域名后运行：./init.sh --url https://你的域名"
ok "已部署"

# ---------- 5. 上报密钥 ----------
step "上报密钥"
NEW_SECRET=0
if (( NEW_TOKEN )) || [[ -z "$INGEST_TOKEN" ]]; then INGEST_TOKEN="$(rand)"; NEW_SECRET=1; fi
save_env
if (( NEW_SECRET )); then
  printf "%s" "$INGEST_TOKEN" | wr secret put INGEST_TOKEN >/dev/null
  ok "已生成并设置 INGEST_TOKEN"
else
  ok "沿用已有的 INGEST_TOKEN"
fi

# ---------- 6. 网页读取的 API 地址 ----------
CONFIG_JS="$ROOT/web/config.js"
if ! grep -qF "'$API_URL'" "$CONFIG_JS"; then
  URL="$API_URL" node -e '
    const fs = require("fs"); const f = process.argv[1];
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/window\.SONDE_API = .*;/, `window.SONDE_API = ${JSON.stringify(process.env.URL).replace(/"/g, "\x27")};`));' "$CONFIG_JS"
  ok "web/config.js 已写入 API 地址"
fi

# ---------- 7. 自检 ----------
step "自检"
for i in $(seq 1 12); do
  curl -fsS -m 10 "$API_URL/api/status" >/dev/null 2>&1 && break
  (( i == 12 )) && die "访问不到 $API_URL/api/status。新的 workers.dev 子域要几分钟生效，稍后重新运行 ./init.sh"
  sleep 5
done
code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$API_URL/ingest" -H "Authorization: Bearer $INGEST_TOKEN" -d '{}')
# 密钥正确时空数据返回 400（bad source）；返回 401 说明新密钥还没生效
case "$code" in
  400) ok "API 正常，上报密钥有效" ;;
  401) warn "上报密钥还没生效（刚设置的 secret 要几秒），稍后再运行一次 ./init.sh 自检" ;;
  *)   warn "上报接口返回 HTTP $code" ;;
esac

# ---------- 完成 ----------
cat <<EOF

${G}${B}部署完成${N}
  API 地址   $API_URL
  上报密钥   保存在 .sonde.env 的 INGEST_TOKEN

把下面两行加进三个工具的配置文件，它们下一次运行后就会出现在网页上：
  /etc/traffic-bot.env（改完 systemctl restart traffic-bot）
  /etc/cdt-guard.env
  /etc/cfst-ddns.env

    SONDE_URL=$API_URL
    SONDE_TOKEN=$INGEST_TOKEN

网页：把仓库接到 Cloudflare Pages 和 / 或 Vercel，根目录填 web，没有构建命令（见 README「部署网页」）
以后更新：./update.sh
EOF
(( NEW_SECRET && ! FIRST_RUN )) && warn "上报密钥换了：三个工具配置里的 SONDE_TOKEN 都要改成上面这个，旧的已经失效"
if ! git -C "$ROOT" diff --quiet -- worker/wrangler.toml web/config.js 2>/dev/null; then
  echo
  warn "worker/wrangler.toml / web/config.js 有改动（database_id、API 地址，都不是机密），提交后网页才会用上："
  echo "    git add worker/wrangler.toml web/config.js && git commit -m 'config: deploy' && git push"
fi
