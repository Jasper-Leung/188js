# Gift No.188 v2 -- trailer assembly
# 实拍：shots/screencast2（自动驾驶，55fps 整圈，载具/视角轮换）
# 片头片尾：promo/assets/cover2-16x9.jpg
# 配乐：promo/assets/score.mp3
#
# PowerShell 注意事项（踩过的坑）：
#  * 双引号串里 "$变量:" 会被当成盘符限定变量（$env:PATH），紧跟冒号的变量一律写 ${变量}
#  * ffmpeg drawtext 的 text 里不能有单引号，会提前闭合滤镜参数引号
#  * 不要用 concat demuxer 处理 Windows 绝对路径（会再拼一次目录），改成 Push-Location + 裸文件名
#  * 不要设 $ErrorActionPreference='Stop'，它会把 ffmpeg 的正常 stderr 变成终止性错误
$ErrorActionPreference = 'Continue'

$root   = 'D:\code\20261004\188threejs'
$frames = Join-Path $root 'shots\screencast2'
$assets = Join-Path $root 'promo\assets'
$tmp    = Join-Path $root '.cache\trailer2'
$out    = Join-Path $root 'promo\GiftNo188-Trailer-v2.mp4'

$S1 = 'C\:/Windows/Fonts/georgia.ttf'   # 衬线，台词
$SA = 'C\:/Windows/Fonts/arial.ttf'     # 无衬线，副题
$PC = '0xFEFae0'                        # 羊皮纸
$RC = '0xbc6c25'                        # 赭石
$cover = Join-Path $assets 'cover2-16x9.jpg'

function Need($p) {
  if (-not (Test-Path $p)) { return $true }
  return ((Get-Item $p).Length -lt 4096)
}

# 选段：源 55fps，每段取 230 帧重采样到 30fps = 7.67s。
# 这些起点都落在「骑在路上 + 能看见 Miles Lu」的区间，避开了自动驾驶跑偏的那几段。
$segs = @(
  @{ n='s1'; s=100  }, @{ n='s2'; s=1100 }, @{ n='s3'; s=1800 },
  @{ n='s4'; s=2900 }, @{ n='s5'; s=3600 }, @{ n='s6'; s=4300 },
  @{ n='s7'; s=9950 }, @{ n='s8'; s=11300 }
)

New-Item -ItemType Directory -Force -Path $tmp | Out-Null

# ---------- A. 截取实拍片段 ----------
foreach ($g in $segs) {
  $dst = Join-Path $tmp "$($g.n).mp4"
  if (Need $dst) {
    & ffmpeg -hide_banner -loglevel error -y `
      -start_number $g.s -i (Join-Path $frames 'f%05d.jpg') `
      -frames:v 230 -r 30 -q:v 3 $dst
    if ($LASTEXITCODE -ne 0) { throw "segment $($g.n) failed" }
  }
}
Write-Host 'A: segments ok'

# ---------- B. 片头 ----------
if (Need (Join-Path $tmp 'title.mp4')) {
  $vf = "scale=1920:1073,pad=1920:1080:0:(oh-ih)/2,setsar=1,format=yuv420p," +
        "drawbox=x=0:y=0:w=1920:h=1080:color=black@0.30:t=fill," +
        "drawtext=fontfile='${S1}':text='GIFT NO.188':fontcolor=${PC}:fontsize=100:x=(w-tw)/2:y=h*0.30:shadowcolor=black@0.55:shadowx=3:shadowy=3," +
        "drawtext=fontfile='${SA}':text='You cannot change the past.':fontcolor=${PC}:fontsize=40:x=(w-tw)/2:y=h*0.50," +
        "drawtext=fontfile='${SA}':text='You can only find out what happened there.':fontcolor=${PC}:fontsize=30:x=(w-tw)/2:y=h*0.555"
  & ffmpeg -hide_banner -loglevel error -y -loop 1 -t 5 -i $cover -vf $vf -r 30 -c:v libx264 -preset medium -crf 19 (Join-Path $tmp 'title.mp4')
  if ($LASTEXITCODE -ne 0) { throw 'title failed' }
}

# ---------- C. 片尾 ----------
if (Need (Join-Path $tmp 'end.mp4')) {
  $vf = "scale=1920:1073,pad=1920:1080:0:(oh-ih)/2,setsar=1,format=yuv420p," +
        "drawbox=x=0:y=0:w=1920:h=1080:color=black@0.38:t=fill," +
        "drawtext=fontfile='${S1}':text='I, too, am a traveller.':fontcolor=${PC}:fontsize=58:x=(w-tw)/2:y=h*0.27:shadowcolor=black@0.5:shadowx=2:shadowy=2," +
        "drawtext=fontfile='${SA}':text='eight hundred years ago, on this road':fontcolor=${PC}:fontsize=28:x=(w-tw)/2:y=h*0.355," +
        "drawtext=fontfile='${SA}':text='GIFT NO.188':fontcolor=${RC}:fontsize=34:x=(w-tw)/2:y=h*0.56," +
        "drawtext=fontfile='${SA}':text='Liang Zhuowen':fontcolor=${PC}:fontsize=28:x=(w-tw)/2:y=h*0.625," +
        "drawtext=fontfile='${SA}':text='Miles Lu and Route No.188 are fictional.':fontcolor=${PC}:fontsize=17:x=(w-tw)/2:y=h*0.74"
  & ffmpeg -hide_banner -loglevel error -y -loop 1 -t 6 -i $cover -vf $vf -r 30 -c:v libx264 -preset medium -crf 19 (Join-Path $tmp 'end.mp4')
  if ($LASTEXITCODE -ne 0) { throw 'end failed' }
}
Write-Host 'B+C: cards ok'

# ---------- D. 归一化 + 拼接 ----------
$order = @('title') + ($segs | ForEach-Object { $_.n }) + @('end')
foreach ($n in $order) {
  $dst = Join-Path $tmp "n_$n.mp4"
  if (Need $dst) {
    & ffmpeg -hide_banner -loglevel error -y -i (Join-Path $tmp "$n.mp4") `
      -vf 'scale=1920:1080:flags=bicubic,setsar=1,format=yuv420p' -r 30 -an -c:v libx264 -preset medium -crf 18 $dst
    if ($LASTEXITCODE -ne 0) { throw "norm $n failed" }
  }
}

$joined = Join-Path $tmp 'joined.mp4'
if (Need $joined) {
  $lines = $order | ForEach-Object { "file 'n_$_.mp4'" }
  Set-Content -Path (Join-Path $tmp 'list.txt') -Value ($lines -join "`n") -Encoding ascii
  Push-Location $tmp
  try { & ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i 'list.txt' -c copy $joined }
  finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw 'join failed' }
}
Write-Host 'D: joined'

# ---------- E. 叠台词 ----------
# 片头 5s + 8 段 x 7.67s = 实拍区 5~66.3s；片尾 66.3~72.3s。台词必须落在 5~66 之间。
function Beat($t1, $t2, $txt, $sz) {
  "drawtext=fontfile='${S1}':text='${txt}':fontcolor=${PC}:fontsize=${sz}:x=(w-tw)/2:y=h-170:box=1:boxcolor=black@0.48:boxborderw=26:enable='between(t,${t1},${t2})'"
}
$beats = @(
  (Beat 9  15 "Touch an old object. It remembers." 44),
  (Beat 18 24 "An ink brush. A chipped cup. A letter nobody sent." 36),
  (Beat 27 33 "Six seconds. A room, a season, a face going soft." 38),
  (Beat 36 42 "You cannot change the past." 46),
  (Beat 45 51 "Eight hundred years ago, a poet came up this road and never left." 32),
  (Beat 54 60 "He was happy here. Echoes cannot flatter." 38),
  (Beat 62 66 "Miles Lu stayed to find out why." 40)
) -join ','

$silent = Join-Path $tmp 'silent.mp4'
if (Need $silent) {
  & ffmpeg -hide_banner -loglevel error -y -i $joined -vf "${beats},format=yuv420p" `
    -c:v libx264 -preset medium -crf 20 -an $silent
  if ($LASTEXITCODE -ne 0) { throw 'beats failed' }
}
Write-Host 'E: beats ok'

# ---------- F. 配乐 ----------
$music = Join-Path $assets 'score.mp3'
if (-not (Test-Path $music)) { throw 'score.mp3 missing' }
& ffmpeg -hide_banner -loglevel error -y -i $silent -stream_loop -1 -i $music `
  -filter_complex '[1:a]volume=0.34,afade=t=in:st=0:d=3,afade=t=out:st=66:d=6[a]' `
  -map 0:v -map '[a]' -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart $out
if ($LASTEXITCODE -ne 0) { throw 'mux failed' }
Write-Host "F: WROTE $out"
