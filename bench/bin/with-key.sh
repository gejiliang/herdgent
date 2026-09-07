#!/bin/zsh
# 唯一作用：把网关密钥从 GG 的 shell 配置带进受测 harness，而【评测台代码全程不经手明文】。
#
# 为什么要 source ~/.zshrc：NEWAPI_API_KEY 定义在那里，
# 而 .zshrc 只有 interactive shell 会自动读（-l 登录 shell 读的是 .zprofile/.zshenv，实测拿不到 key）。
#
# 为什么 HOME 要在这里换、而不是让 Node spawn 时直接设：
# 顺序是 load-bearing 的 —— source .zshrc 时 HOME 必须还是真的，
# 否则读的是 $BENCH_HOME/.zshrc（不存在），拿不到 key。
# 所以 Node 传进来的是 BENCH_HOME，等 key 已在 env 里，才在 exec 这一步切过去。

# 【必须在 source 之前】把真 stdout 藏进 fd 3，脚本自身的输出改道 stderr。
# 原因：oh-my-zsh 的 preexec 钩子一旦被 .zshrc 挂上，就会对【之后每一条命令】
# 往 stdout 打终端标题转义序列（实测 `zsh -i` 和非交互手动 source 都一样，
# 连「清理钩子」那条命令自己都会触发一次，躲不掉）。
# 这些字节混进受测 harness 的输出里，判分器就得去解析垃圾。
# 改道之后噪声全进 stderr —— 那本来就是诊断通道，判分只看 stdout。
exec 3>&1 1>&2

[[ -n "$BENCH_HOME" ]] || { print -u2 "with-key.sh: BENCH_HOME not set"; exit 64 }

# .zshrc 的噪声（补全初始化、插件加载、可能的 echo）一律丢掉，只要它的副作用：环境变量。
source "${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1

[[ -n "$NEWAPI_API_KEY" ]] || { print -u2 "with-key.sh: NEWAPI_API_KEY not found after sourcing .zshrc"; exit 65 }

# opencode / codex / claude 三家的配置原生支持引用环境变量（{env:...} / env_key / ANTHROPIC_AUTH_TOKEN），
# 密钥不落盘。pi 和 kimi 只接受配置文件里的明文，所以模板里放 __NEWAPI_KEY__ 占位符，
# 在【运行时实例】上就地替换 —— 实例在 tmp 目录，仓库里那份模板永远是占位符。
# 用 perl 从 $ENV 读而不是 sed 传参：密钥不进 argv，ps 看不到。
grep -rlF '__NEWAPI_KEY__' "$BENCH_HOME" 2>/dev/null | while IFS= read -r f; do
  perl -pi -e 's/__NEWAPI_KEY__/$ENV{NEWAPI_API_KEY}/g' "$f" || exit 66
done

# 网关地址同样是占位符：跑评测时它指向本地计量代理，五家的请求都从那里过，
# 才有可能用同一把尺子数 token（各家自报的口径根本对不上，见 lib/meter.mjs）。
# 没设 BENCH_BASE_URL 时回落到网关本身，方便单独调试某一家。
: ${BENCH_BASE_URL:=https://newapi.gejiliang.com}
grep -rlF '__BASE_URL__' "$BENCH_HOME" 2>/dev/null | while IFS= read -r f; do
  perl -pi -e 's{__BASE_URL__}{$ENV{BENCH_BASE_URL}}g' "$f" || exit 67
done

# 1>&3 把子进程的 stdout 接回真正的 stdout；3>&- 不让 fd 3 泄漏进受测进程。
# ANTHROPIC_AUTH_TOKEN 是 Claude Code 认的密钥变量。在这里统一注入，
# adapter 层就不必碰密钥；其余 harness 不认这个变量，设了也无害。
exec env \
  HOME="$BENCH_HOME" \
  ANTHROPIC_AUTH_TOKEN="$NEWAPI_API_KEY" \
  ANTHROPIC_BASE_URL="$BENCH_BASE_URL" \
  XDG_CONFIG_HOME="$BENCH_HOME/.config" \
  XDG_DATA_HOME="$BENCH_HOME/.local/share" \
  XDG_STATE_HOME="$BENCH_HOME/.local/state" \
  XDG_CACHE_HOME="$BENCH_HOME/.cache" \
  "$@" 1>&3 3>&-
