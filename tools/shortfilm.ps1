# Gift No.188 -- 短片合成
#
# 结构（约 78s，1920x1080 / 30fps）：
#   0.0 - 5.5   排版：Smile
#   5.5 - 13.5  古代文人聚会（AI 生成实拍）
#  13.5 - 21.5  排版：Smile -> miles（FLIP 把 S 挪到末尾并转小写）
#  21.5 - 29.0  排版：辞职旁白
#  29.0 - 34.0  排版：Lu
#  34.0 - 39.0  排版：路
#  39.0 - 43.0  排版：Road
#  43.0 - 51.0  游戏实景（第一视角）：老建筑
#  51.0 - 59.0  游戏实景（第一视角）：现代建筑
#  59.0 - 73.0  游戏实景（第一视角）+ 探索真相对白
#  73.0 - 78.0  片尾
#
# PowerShell 注意：
#  * "$变量:" 会被当盘符限定变量 -> 一律 ${变量}
#  * drawtext 的 text 里不能有单引号 / 冒号
#  * 不要设 $ErrorActionPreference='Stop'
$ErrorActionPreference = 'Continue'

$root  = 'D:\code\20261004\188threejs'
$typo  = Join-Path $root 'shots\typo'
$fp    = Join-Path $root 'shots\firstperson2'
$assets= Join-Path $root 'promo\shortfilm\assets'
$tmp   = Join-Path $root '.cache\shortfilm'
$out   = Join-Path $root 'promo\shortfilm\GiftNo188-ShortFilm-v2.mp4'

$S1 = 'C\:/Windows/Fonts/georgia.ttf'
$SA = 'C\:/Windows/Fonts/arial.ttf'
$PC = '0xFEFae0'
$RC = '0xbc6c25'
$NORM = 'scale=1920:1080:flags=bicubic,setsar=1,format=yuv420p'

function Need($p) {
  if (-not (Test-Path $p)) { return $true }
  return ((Get-Item $p).Length -lt 4096)
}
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

# 台词打底的盒子样式
function Line($t1, $t2, $txt, $sz) {
  "drawtext=fontfile='${S1}':text='${txt}':fontcolor=${PC}:fontsize=${sz}:x=(w-tw)/2:y=h-190:box=1:boxcolor=black@0.52:boxborderw=28:enable='between(t,${t1},${t2})'"
}
function Note($t1, $t2, $txt, $sz) {
  "drawtext=fontfile='${SA}':text='${txt}':fontcolor=${PC}:fontsize=${sz}:x=(w-tw)/2:y=120:box=1:boxcolor=black@0.42:boxborderw=24:enable='between(t,${t1},${t2})'"
}

# ---------- A. 排版段 ----------
# A1 = 0 - 5.5s  -> 帧 0..164
if (Need (Join-Path $tmp 'a1v2.mp4')) {
  & ffmpeg -hide_banner -loglevel error -y -start_number 0 -i (Join-Path $typo 't%05d.jpg') `
    -frames:v 165 -r 30 -vf "$NORM" -c:v libx264 -preset medium -crf 18 (Join-Path $tmp 'a1v2.mp4')
}
# A2 = 13.5 - 43s -> 帧 405..1289
if (Need (Join-Path $tmp 'a2v2.mp4')) {
  & ffmpeg -hide_banner -loglevel error -y -start_number 405 -i (Join-Path $typo 't%05d.jpg') `
    -frames:v 885 -r 30 -vf "$NORM" -c:v libx264 -preset medium -crf 18 (Join-Path $tmp 'a2v2.mp4')
}
Write-Host 'A: typo segments ok'

# ---------- B. 古代文人（AI 生成） ----------
if (Need (Join-Path $tmp 'b1.mp4')) {
  & ffmpeg -hide_banner -loglevel error -y -i (Join-Path $assets 'literati.mp4') `
    -t 8 -vf "$NORM" -r 30 -an -c:v libx264 -preset medium -crf 18 (Join-Path $tmp 'b1.mp4')
}
Write-Host 'B: literati ok'

# ---------- C. 游戏实景（第一视角，徒步） ----------
# 只取 f03500 之后：更早的帧还带着角色模型，正是要避开的。
# 起点是逐张打开确认过的帧，不是按坐标估的。
$gameSegs = @(
  @{ n='v4a'; s=14500; c=240 },   # 老建筑：路两侧一排起翘屋顶的亭子
  @{ n='v4b'; s=10200; c=240 },   # 现代建筑：老房子 + 白色现代体量同框
  @{ n='v4c'; s=16100; c=420 }    # 探索真相 + 对白：湖畔亭子
)
foreach ($g in $gameSegs) {
  $dst = Join-Path $tmp "$($g.n).mp4"
  if (Need $dst) {
    & ffmpeg -hide_banner -loglevel error -y -start_number $g.s -i (Join-Path $fp 'f%05d.jpg') `
      -frames:v $g.c -r 30 -vf "$NORM" -c:v libx264 -preset medium -crf 18 $dst
    if ($LASTEXITCODE -ne 0) { throw "seg $($g.n) failed" }
  }
}

# C1 老建筑：只挂说明，不盖对白
$vfC1 = "$NORM," + (Note 0.6 7.4 "the old road -- what his family kept" 40)
& ffmpeg -hide_banner -loglevel error -y -i (Join-Path $tmp 'v4a.mp4') `
  -vf $vfC1 -c:v libx264 -preset medium -crf 20 -an (Join-Path $tmp 'c1t.mp4')

# C2 现代建筑
$vfC2 = "$NORM," + (Note 0.6 7.4 "the development -- three towers, four round houses" 36)
& ffmpeg -hide_banner -loglevel error -y -i (Join-Path $tmp 'v4b.mp4') `
  -vf $vfC2 -c:v libx264 -preset medium -crf 20 -an (Join-Path $tmp 'c2t.mp4')

# C3 探索真相：对白用游戏里的原句（去掉单引号）
$dialogue = @(
  (Line 0.6 4.2 "Past the fork to the south there is an old road bed no map records." 32),
  (Line 4.6 8.2 "We dug an inscribed stone out of it." 34),
  (Line 8.6 12.2 "She went to see that same stone. After that, she never came back." 32),
  (Line 12.6 16.0 "Marked No.188. This road knows everyone who has walked it." 32)
) -join ','

$tail = "$NORM," +
  (Line 16.4 20.0 "The letters have been chiselled away. Half a 188 is all that is left." 30) + "," +
  "drawtext=fontfile='${S1}':text='He came back to find out what the old road was keeping.':fontcolor=${RC}:fontsize=36:x=(w-tw)/2:y=h-190:box=1:boxcolor=black@0.52:boxborderw=28:enable='between(t,20.2,23.4)'"

$vfC3 = "$NORM,$dialogue,$tail"
& ffmpeg -hide_banner -loglevel error -y -i (Join-Path $tmp 'v4c.mp4') `
  -vf $vfC3 -c:v libx264 -preset medium -crf 20 -an (Join-Path $tmp 'c3t.mp4')
if ($LASTEXITCODE -ne 0) { throw 'C3 overlay failed' }
Write-Host 'C: game segments ok'

# ---------- D. 片尾 ----------
if (Need (Join-Path $tmp 'd1.mp4')) {
  $vf = "$NORM," +
        "drawtext=fontfile='${S1}':text='GIFT NO.188':fontcolor=${PC}:fontsize=92:x=(w-tw)/2:y=h*0.36," +
        "drawtext=fontfile='${SA}':text='Liang Zhuowen':fontcolor=${RC}:fontsize=34:x=(w-tw)/2:y=h*0.47," +
        "drawtext=fontfile='${SA}':text='Miles Lu and Route No.188 are fictional.':fontcolor=${PC}:fontsize=20:x=(w-tw)/2:y=h*0.56"
  # 封面在 promo\assets，不在 promo\shortfilm\assets
  $cover = Join-Path $root 'promo\assets\cover2-16x9.jpg'
  & ffmpeg -hide_banner -loglevel error -y -loop 1 -t 5 -i $cover `
    -vf $vf -r 30 -c:v libx264 -preset medium -crf 18 (Join-Path $tmp 'd1.mp4')
  if ($LASTEXITCODE -ne 0) { throw 'end card failed' }
}
Write-Host 'D: end card ok'

# ---------- E. 拼接 ----------
$order = @('a1v2.mp4','b1.mp4','a2v2.mp4','c1t.mp4','c2t.mp4','c3t.mp4','d1.mp4')
$lines = $order | ForEach-Object { "file '$_'" }
Set-Content -Path (Join-Path $tmp 'list.txt') -Value ($lines -join "`n") -Encoding ascii
$joined = Join-Path $tmp 'joined3.mp4'
if (Need $joined) {
  Push-Location $tmp
  try { & ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i 'list.txt' -c copy $joined }
  finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw 'join failed' }
}

# ---------- F. 配乐 ----------
$music = Join-Path $root 'promo\assets\score.mp3'
& ffmpeg -hide_banner -loglevel error -y -i $joined -stream_loop -1 -i $music `
  -filter_complex '[1:a]volume=0.30,afade=t=in:st=0:d=3,afade=t=out:st=74:d=4[a]' `
  -map 0:v -map '[a]' -c:v copy -c:a aac -b:a 160k -shortest -movflags +faststart $out
if ($LASTEXITCODE -ne 0) { throw 'mux failed' }
Write-Host "WROTE $out"
