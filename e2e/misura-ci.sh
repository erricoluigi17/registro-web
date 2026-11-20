#!/usr/bin/env bash
# MISURA (ramo di prova, non va in main): ogni 30 s memoria, scambio, carico, pressione
# e i processi piu' pesanti, dentro lo stesso registro della suite E2E.
echo "[misura] nproc=$(nproc)"; free -m | sed 's/^/[misura] /'; swapon --show | sed 's/^/[misura] swap: /'
grep -E 'model name' /proc/cpuinfo | sort | uniq -c | sed 's/^/[misura] /'
df -h / /mnt 2>/dev/null | sed 's/^/[misura] /'
while kill -0 "$1" 2>/dev/null; do
  t=$(date -u +%H:%M:%S)
  mem=$(free -m | awk '/^Mem:/{printf "usata=%s libera=%s cache=%s disponibile=%s", $3,$4,$6,$7} /^Swap:/{printf " swap_usato=%s/%s", $3,$2}')
  load=$(cut -d' ' -f1-3 /proc/loadavg)
  pm=$(awk '/^some/{print $2}' /proc/pressure/memory 2>/dev/null)
  pc=$(awk '/^some/{print $2}' /proc/pressure/cpu 2>/dev/null)
  pio=$(awk '/^some/{print $2}' /proc/pressure/io 2>/dev/null)
  echo "[misura] $t MB: $mem | carico: $load | pressione mem $pm cpu $pc io $pio"
  ps -eo rss=,comm= | awk '{a[$2]+=$1; n[$2]++} END{for(k in a) if(a[k]>150000) printf "%s=%dMB(x%d) ", k, a[k]/1024, n[k]; print ""}' | sed "s/^/[misura] $t per nome: /"
  ps -eo rss=,pcpu=,pid=,args= --sort=-rss | head -4 | awk '{printf "[misura]    %5d MB %5s%% pid %s %s\n", $1/1024, $2, $3, substr($0, index($0,$4), 110)}'
  sudo -n dmesg 2>/dev/null | grep -i -E 'out of memory|oom-kill|killed process' | tail -3 | sed 's/^/[misura] dmesg: /'
  sleep 30
done
echo "[misura] fine: il processo di Playwright non c'e' piu'"
