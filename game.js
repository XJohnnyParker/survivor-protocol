/* 幸存者协议 · Survivor Protocol
 * 俯视角射击 / 波次生存 · 单页可玩原型
 * 按《一个人做一款游戏》大纲实现：
 *   玩家（WASD + 鼠标瞄准 + 左键射击）→ 击杀掉落经验 → 升级三选一 → 10 波越来越强 → Boss
 * 美术全部是几何图形，无外部素材、无网络请求。
 */
(function () {
  'use strict';

  // ==================== 基础 ====================
  const W = 1280, H = 720;            // 视口：摄像机看到的那一块
  // 世界比视口大得多：按 WASD 走动时是"地图在动"（摄像机跟着玩家），视野有限
  const WORLD = { w: 3200, h: 2400 };
  const cv = document.getElementById('cv');
  const ctx = cv.getContext('2d');

  function resize() {
    // 手机上按 2 倍像素密度渲染 1280x720 会烧 GPU，触屏设备封顶 1.5 倍
    const dpr = Math.min(window.devicePixelRatio || 1, MOBILE ? 1.5 : 2);
    const s = Math.min(window.innerWidth / W, window.innerHeight / H);
    const cw = Math.max(320, Math.floor(W * s)), ch = Math.floor(H * s);
    cv.style.width = cw + 'px';
    cv.style.height = ch + 'px';
    cv.width = Math.floor(cw * dpr);
    cv.height = Math.floor(ch * dpr);
    // 把 1280x720 的游戏世界按比例映射到画布上（画布与世界等比，所以横纵同一个比例）。
    // 之前只乘了 dpr：世界只占画布左上角，右侧/下侧多出一圈"空条"，
    // 屏幕外生成的敌人、飞出边界的子弹就会露在那圈里（看起来像"屏幕外的怪影/残留"）。
    // 乘上 scale 之后，世界外的东西被画布边界裁掉，再也不漏。
    ctx.setTransform(dpr * (cw / W), 0, 0, dpr * (ch / H), 0, 0);
    G.view.w = cw; G.view.h = ch;
  }
  const G = { view: { w: W, h: H } };

  // ==================== 数据表 ====================
  // 敌人：外观 / 生命 / 速度 / 伤害 / 经验 / 半径 / 转向迟滞（turn 越小越笨重）/ 耐久（撞玩家几次才消失）
  const ENEMY = {
    grunt: { name: '小兵', shape: 'tri', color: '#ff5c5c', hp: 20, speed: 120, dmg: 5, xp: 1, r: 14, turn: 3.5, hits: 2 },
    fast: { name: '快速兵', shape: 'circ', color: '#ffd166', hp: 15, speed: 200, dmg: 8, xp: 2, r: 11, turn: 4.2, hits: 2 },
    tank: { name: '坦克', shape: 'square', color: '#c792ff', hp: 60, speed: 80, dmg: 15, xp: 5, r: 20, turn: 2.2, hits: 4 },
    boss: { name: '首领', shape: 'hex', color: '#25252f', hp: 300, speed: 60, dmg: 25, xp: 50, r: 52, stroke: '#ff4d6d', turn: 1.5, hits: 6 },
  };

  // 波次：持续秒数 / 生成间隔 / 混合权重 / 是否出 Boss
  const WAVE = [
    { dur: 20, interval: 2.0, mix: [['grunt', 1]] },
    { dur: 20, interval: 1.5, mix: [['grunt', 1]] },
    { dur: 25, interval: 1.8, mix: [['grunt', 2], ['fast', 1]] },
    { dur: 25, interval: 1.2, mix: [['fast', 2], ['grunt', 1]] },
    { dur: 30, interval: 1.5, mix: [['grunt', 2], ['fast', 1], ['tank', 1]] },
    { dur: 30, interval: 1.3, mix: [['grunt', 3], ['fast', 2], ['tank', 1]] },
    { dur: 30, interval: 1.1, mix: [['grunt', 3], ['fast', 3], ['tank', 2]] },
    { dur: 30, interval: 0.95, mix: [['grunt', 4], ['fast', 3], ['tank', 2]] },
    { dur: 30, interval: 0.8, mix: [['grunt', 4], ['fast', 4], ['tank', 3]] },
    { dur: 60, interval: 1.6, mix: [['grunt', 3], ['fast', 2], ['tank', 1]], boss: true },
  ];

  // 升级三选一
  const UPGRADE = [
    { id: 'dmg', name: '伤害提升', desc: '子弹伤害 +5', icon: '◆',
      apply: function () { P.damage += 5; } },
    { id: 'rps', name: '射速提升', desc: '射击冷却 -0.02s（最低 0.08s）', icon: '⟳',
      apply: function () { P.cooldown = Math.max(0.08, P.cooldown - 0.02); } },
    { id: 'spd', name: '移速提升', desc: '移动速度 +30', icon: '≫',
      apply: function () { P.speed += 30; } },
    { id: 'heal', name: '生命恢复', desc: '立即恢复 30 生命', icon: '✚',
      apply: function () { P.hp = Math.min(P.maxHp, P.hp + 30); } },
    { id: 'maxhp', name: '最大生命', desc: '最大生命 +20，并回满', icon: '❤',
      apply: function () { P.maxHp += 20; P.hp = P.maxHp; } },
    { id: 'pierce', name: '穿透', desc: '子弹可多穿透 1 个敌人', icon: '➤',
      apply: function () { P.pierce += 1; } },
  ];

  // 回血 / 护盾包：每 every 秒掷一次骰子，chance 概率在视野内刷一个（50/50 是回血还是护盾）
  // heal: 回血量；shield: 一次加多少盾；shieldShare: 护盾上限 = 生命上限 × 这个比例
  const HEALPACK = { chance: 0.30, every: 4.0, heal: 10, shield: 20, shieldShare: 0.5,
                     shieldChance: 0.5, max: 3, life: 15, r: 16 };

  // 移动手感：按住方向键时按 accel 的速率逼近满速（约 0.1 秒到 90%），
  // 松手后按 damp 的速率衰减 —— 会往前"滑"一小段，滑行距离约 speed/damp。
  // accel 调大 = 起步更干脆；damp 调大 = 松手停得越快（越小越滑）。
  const MOVE = { accel: 22, damp: 4.2, trailSpeed: 90 };

  // ==================== 运行时状态 ====================
  let P = null;                       // 玩家
  const S = {                         // 全局
    state: 'title',                   // title | playing | break | upgrade | dead | win | paused
    t: 0, elapsed: 0, kills: 0,
    wave: 1, waveTime: 0, spawnT: 0, breakT: 0,
    bullets: [], enemies: [], parts: [], rings: [],
    packs: [], floats: [], packT: 0,
    cam: { x: WORLD.w / 2, y: WORLD.h / 2 },   // 摄像机中心（世界坐标）
    obstacles: [],                              // 障碍物：{type:'rect'|'circle', ...}
    banner: null,                     // { text, t }
    choices: [], pendingLevels: 0,
    levelFx: 0, muted: false, best: 0,
    settings: false,                  // 左上角 ⚙ 设置面板是否打开（打开时世界冻结）
    shake: 0,
  };
  const keys = Object.create(null);
  const mouse = { x: W / 2, y: H / 2, down: false };

  // ==================== 手机模式（触屏操作） ====================
  // 手机 / 平板上两套手势同时走：
  //   左手 —— 屏幕左下方按住拖动 = 虚拟摇杆（拖动原点跟着按下点走，不固定死）
  //   右手 —— 屏幕任意其他地方按住 = "点哪打哪"：枪口指向按下的那个世界坐标点，
  //           按住不放就持续开火；手指移动，瞄准点跟着移动
  // 键盘 / 鼠标的路径完全没动，桌面照旧，带触屏的笔记本也能两套混用。
  //
  // 手机模式本身可以在左上角的 ⚙ 设置里开关（记在 localStorage），
  // 地址栏的 ?touch=1 / ?touch=0 是给自动化测试用的强制开关。
  const TOUCH_URL = (function () {
    try {
      if (/[?&]touch=1\b/.test(location.search)) return true;
      if (/[?&]touch=0\b/.test(location.search)) return false;
    } catch (e) { /* 没有 location 的极端环境 */ }
    return null;
  })();
  // 设备本身有没有触屏（只用来说明"默认该开还是该关"）
  const TOUCH_CAP = TOUCH_URL !== null ? TOUCH_URL : (function () {
    try {
      return (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
             ('ontouchstart' in window);
    } catch (e) { return false; }
  })();
  const MOBILE_KEY = 'sp-mobile-mode';
  let MOBILE = (function () {
    if (TOUCH_URL !== null) return TOUCH_URL;      // 网址强制，不读存档
    try {
      const saved = localStorage.getItem(MOBILE_KEY);
      if (saved === '1') return true;
      if (saved === '0') return false;
    } catch (e) { /* 无痕模式可能禁 localStorage */ }
    return TOUCH_CAP;                              // 默认跟着设备能力
  })();
  function setMobileMode(on) {
    MOBILE = !!on;
    if (!MOBILE) touchReset();
    else touch.hint = 6;                           // 打开时给一次操作提示
    try { localStorage.setItem(MOBILE_KEY, MOBILE ? '1' : '0'); } catch (e) {}
  }
  // 摇杆几何：STICK.x/y 是"没被按住时"提示圈的位置，真正生效的原点是按下点
  const STICK = { x: 152, y: H - 176, r: 92, knob: 46, zoneX: 0.46, zoneY: 0.44 };
  const touch = {
    moveId: null, ox: 0, oy: 0, mx: 0, my: 0,   // 摇杆：按下原点 + 当前手指点
    aimId: null, ax: 0, ay: 0,                  // 瞄准：按下点（逻辑屏幕坐标）
    hint: 0,                                    // 开场提示剩余秒数
  };
  // 准星的"最后落点"（逻辑屏幕坐标）：鼠标和手指都往这里写，
  // 松手之后枪口就停在那，而不是跳回某个过期的鼠标位置。
  const aimPoint = { x: W / 2 + 160, y: H / 2 };
  const touchReset = function () {
    touch.moveId = null; touch.aimId = null;
    touch.ox = touch.oy = touch.mx = touch.my = 0;
  };


  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  try { S.best = parseFloat(localStorage.getItem('sp-best-elapsed') || '0') || 0; } catch (e) { S.best = 0; }

  // ==================== 声音（WebAudio 合成，M 静音） ====================
  let AC = null;
  function beep(freq, dur, type, vol) {
    if (S.muted) return;
    try {
      if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
      const o = AC.createOscillator(), gnode = AC.createGain();
      o.type = type || 'square';
      o.frequency.value = freq;
      gnode.gain.value = vol === undefined ? 0.05 : vol;
      o.connect(gnode); gnode.connect(AC.destination);
      const t0 = AC.currentTime;
      gnode.gain.setValueAtTime(gnode.gain.value, t0);
      gnode.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.start(t0); o.stop(t0 + dur);
    } catch (e) { /* 没声卡/被拦截就算了 */ }
  }

  // ==================== 障碍物 / 碰撞工具 ====================
  // 随机摆一批障碍物（矩形 = 墙/箱子，圆 = 石头），出生点周围留空、彼此不重叠
  function makeObstacles() {
    const list = [];
    const cx = WORLD.w / 2, cy = WORLD.h / 2;
    let guard = 0;
    while (list.length < 34 && guard++ < 800) {
      const isRect = Math.random() < 0.55;
      let o;
      if (isRect) {
        const w = rand(140, 320), h = rand(90, 240);
        o = { type: 'rect', x: rand(60, WORLD.w - 60 - w), y: rand(60, WORLD.h - 60 - h), w: w, h: h };
      } else {
        const r = rand(50, 110);
        o = { type: 'circle', x: rand(90, WORLD.w - 90), y: rand(90, WORLD.h - 90), r: r };
      }
      // 出生点周围留一大块空地
      const nearSpawn = o.type === 'rect'
        ? (o.x < cx + 320 && o.x + o.w > cx - 320 && o.y < cy + 320 && o.y + o.h > cy - 320)
        : Math.hypot(o.x - cx, o.y - cy) < 360 + o.r;
      if (nearSpawn) continue;
      // 互相别叠在一起
      let overlap = false;
      for (let i = 0; i < list.length && !overlap; i++) {
        const b = list[i];
        const ax = o.type === 'rect' ? o.x + o.w / 2 : o.x, ay = o.type === 'rect' ? o.y + o.h / 2 : o.y;
        const ar = o.type === 'rect' ? Math.hypot(o.w, o.h) / 2 : o.r;
        const bx = b.type === 'rect' ? b.x + b.w / 2 : b.x, by = b.type === 'rect' ? b.y + b.h / 2 : b.y;
        const br = b.type === 'rect' ? Math.hypot(b.w, b.h) / 2 : b.r;
        if (Math.hypot(ax - bx, ay - by) < ar + br + 30) overlap = true;
      }
      if (overlap) continue;
      list.push(o);
    }
    return list;
  }

  // 某个点是否被障碍物挡住（外扩 pad）
  function pointBlocked(x, y, pad) {
    for (let i = 0; i < S.obstacles.length; i++) {
      const o = S.obstacles[i];
      if (o.type === 'rect') {
        if (x > o.x - pad && x < o.x + o.w + pad && y > o.y - pad && y < o.y + o.h + pad) return true;
      } else if (Math.hypot(x - o.x, y - o.y) < o.r + pad) return true;
    }
    return false;
  }

  // 把一个圆推出所有障碍物；返回 {x, y, hit}
  function pushOut(x, y, r) {
    let hit = false;
    for (let i = 0; i < S.obstacles.length; i++) {
      const o = S.obstacles[i];
      if (o.type === 'rect') {
        if (x + r < o.x || x - r > o.x + o.w || y + r < o.y || y - r > o.y + o.h) continue;
        const nx = clamp(x, o.x, o.x + o.w), ny = clamp(y, o.y, o.y + o.h);
        const dx = x - nx, dy = y - ny, d = Math.hypot(dx, dy);
        if (d < r) {
          hit = true;
          if (d > 0.001) { x = nx + dx / d * r; y = ny + dy / d * r; }
          else {
            // 圆心正好在矩形内部：往最近的边推出去
            const left = x - o.x, right = o.x + o.w - x, top = y - o.y, bottom = o.y + o.h - y;
            const m = Math.min(left, right, top, bottom);
            if (m === left) x = o.x - r; else if (m === right) x = o.x + o.w + r;
            else if (m === top) y = o.y - r; else y = o.y + o.h + r;
          }
        }
      } else {
        const dx = x - o.x, dy = y - o.y, d = Math.hypot(dx, dy), min = r + o.r;
        if (d < min) {
          hit = true;
          if (d > 0.001) { x = o.x + dx / d * min; y = o.y + dy / d * min; }
          else x = o.x + min;
        }
      }
    }
    return { x: x, y: y, hit: hit };
  }

  // 世界坐标是否在摄像机视野里（外扩 pad）
  function inView(x, y, pad) {
    return Math.abs(x - S.cam.x) <= W / 2 + (pad || 0) &&
           Math.abs(y - S.cam.y) <= H / 2 + (pad || 0);
  }

  // 敌人绕障：沿某个方向采样几个点（探针射线），全空才算这条路能走
  function pathClear(e, a) {
    const pad = e.r * 0.85;
    for (let t = 16; t <= 78; t += 14) {
      if (pointBlocked(e.x + Math.cos(a) * t, e.y + Math.sin(a) * t, pad)) return false;
    }
    return true;
  }
  // 正前方能走就直走；不能走就左右各试几个角度（每个敌人有自己的偏好侧）
  function steeringA(e, baseA) {
    if (pathClear(e, baseA)) return baseA;
    const steps = [0.35, 0.7, 1.05, 1.4, 1.75, 2.1];
    for (let i = 0; i < steps.length; i++) {
      const a = baseA + steps[i] * (e.side || 1);
      if (pathClear(e, a)) return a;
    }
    return baseA + (e.side || 1) * 2.1;
  }

  // ==================== 开局 / 重开 ====================
  function reset() {
    P = {
      x: WORLD.w / 2, y: WORLD.h / 2, r: 14, vx: 0, vy: 0,
      trail: [], trailT: 0,
      hp: 100, maxHp: 100, speed: 300,
      shield: 0,
      cooldown: 0.15, cdLeft: 0, damage: 10, pierce: 0,
      level: 1, xp: 0, xpNext: 10,
      aim: 0, flash: 0, hurt: 0,
    };
    S.cam = { x: P.x, y: P.y };
    S.obstacles = makeObstacles();
    S.state = 'playing';
    S.t = 0; S.elapsed = 0; S.kills = 0;
    S.wave = 1; S.waveTime = WAVE[0].dur; S.spawnT = 0.6; S.breakT = 0;
    S.bullets.length = 0; S.enemies.length = 0; S.parts.length = 0; S.rings.length = 0;
    S.packs.length = 0; S.floats.length = 0; S.packT = HEALPACK.every;
    S.banner = { text: '第 1 波', t: 1.0 };
    S.choices = []; S.pendingLevels = 0; S.levelFx = 0; S.shake = 0;
    touchReset();                 // 换局时把没松开的手指状态清掉
    touch.hint = MOBILE ? 9 : 0;   // 手机上开局给 9 秒操作提示
    S.settings = false;
    S.pauseReturn = 'playing';
  }

  // ==================== 生成 ====================
  function spawnEnemy(type, atEdge) {
    const d = ENEMY[type];
    let x, y;
    const m = 70;                                    // 生成在视野外多远
    const vx0 = S.cam.x - W / 2 - m, vx1 = S.cam.x + W / 2 + m;
    const vy0 = S.cam.y - H / 2 - m, vy1 = S.cam.y + H / 2 + m;
    if (atEdge === 'any' || atEdge === undefined) {
      // 生成在"摄像机视野"外面一圈：玩家看不到它冒出来，但它就在屏幕边缘外
      if (Math.random() < 0.5) {
        x = Math.random() < 0.5 ? vx0 : vx1;
        y = rand(vy0, vy1);
      } else {
        x = rand(vx0, vx1);
        y = Math.random() < 0.5 ? vy0 : vy1;
      }
    } else {
      const a = rand(0, Math.PI * 2);
      const rr = Math.max(W, H) * 0.55;
      x = S.cam.x + Math.cos(a) * rr;
      y = S.cam.y + Math.sin(a) * rr;
    }
    x = clamp(x, 24, WORLD.w - 24);
    y = clamp(y, 24, WORLD.h - 24);
    S.enemies.push({ type: type, x: x, y: y, vx: 0, vy: 0, hp: d.hp, maxHp: d.hp, r: d.r,
                     hits: d.hits, hitCd: 0, dying: 0, hitT: 0,
                     side: Math.random() < 0.5 ? 1 : -1, detourA: 0, detourT: 0, stuckT: 0 });
  }
  function spawnFromMix(mix) {
    let total = 0;
    for (let i = 0; i < mix.length; i++) total += mix[i][1];
    let r = Math.random() * total;
    for (let i = 0; i < mix.length; i++) {
      r -= mix[i][1];
      if (r <= 0) { spawnEnemy(mix[i][0]); return; }
    }
    spawnEnemy(mix[0][0]);
  }
  function startWave(n) {
    S.wave = n;
    const cfg = WAVE[Math.min(n, WAVE.length) - 1];
    S.waveTime = cfg.dur;
    S.spawnT = 0.6;
    S.banner = { text: '第 ' + n + ' 波', t: 1.0 };
    S.state = 'playing';
    if (cfg.boss) {
      spawnEnemy('boss');
      S.banner = { text: '第 ' + n + ' 波 · 首领出现', t: 1.6 };
      beep(90, 0.5, 'sawtooth', 0.09);
    }
  }

  // ==================== 玩家 ====================
  function shoot() {
    const sp = 600;
    const a = P.aim;
    const x = P.x + Math.cos(a) * (P.r + 10);
    const y = P.y + Math.sin(a) * (P.r + 10);
    S.bullets.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                     dmg: P.damage, pierce: P.pierce, life: 2.0, r: 4 });
    P.flash = 0.05;
    S.shake = Math.min(6, S.shake + 0.6);
    beep(720, 0.05, 'square', 0.035);
  }
  function hurtPlayer(amount) {
    if (S.state !== 'playing' && S.state !== 'break') return;
    let rest = amount;
    if (P.shield > 0) {                        // 护盾先扛伤害
      const absorbed = Math.min(P.shield, rest);
      P.shield -= absorbed;
      rest -= absorbed;
    }
    if (rest > 0) P.hp -= rest;
    P.hurt = 0.2;
    S.shake = Math.min(14, S.shake + 5);
    beep(rest > 0 ? 120 : 320, rest > 0 ? 0.18 : 0.08, 'sine', 0.07);
    if (P.hp <= 0) {
      P.hp = 0;
      S.state = 'dead';
      if (S.elapsed > S.best) {
        S.best = S.elapsed;
        try { localStorage.setItem('sp-best-elapsed', String(S.best)); } catch (e) { /* ignore */ }
      }
      beep(70, 0.7, 'sawtooth', 0.10);
    }
  }
  function gainXp(n) {
    P.xp += n;
    while (P.xp >= P.xpNext) {
      P.xp -= P.xpNext;
      P.level++;
      P.xpNext = P.level * 10;
      S.pendingLevels++;
      S.levelFx = 0.5;
      S.rings.push({ x: P.x, y: P.y, r: 10, t: 0, max: 0.5 });
      beep(880, 0.12, 'triangle', 0.05);
    }
    if (S.pendingLevels > 0 && (S.state === 'playing' || S.state === 'break')) openUpgrade();
  }
  function openUpgrade() {
    // 记下升级前处于哪个阶段：波次间歇里升的级，选完要回到间歇，别把 3 秒喘息吞掉
    S.upgradeReturn = S.state === 'break' ? 'break' : 'playing';
    const pool = UPGRADE.slice();
    S.choices = [];
    for (let i = 0; i < 3 && pool.length; i++) {
      const k = Math.floor(Math.random() * pool.length);
      S.choices.push(pool.splice(k, 1)[0]);
    }
    S.state = 'upgrade';
  }
  function chooseUpgrade(i) {
    const u = S.choices[i];
    if (!u) return;
    u.apply();
    S.pendingLevels = Math.max(0, S.pendingLevels - 1);
    S.choices = [];
    if (S.pendingLevels > 0) { openUpgrade(); return; }
    S.state = S.upgradeReturn || 'playing';
    beep(1046, 0.1, 'triangle', 0.05);
  }

  // ==================== 更新 ====================
  function updatePlayer(dt) {
    let dx = 0, dy = 0;
    if (keys['w'] || keys['arrowup']) dy -= 1;
    if (keys['s'] || keys['arrowdown']) dy += 1;
    if (keys['a'] || keys['arrowleft']) dx -= 1;
    if (keys['d'] || keys['arrowright']) dx += 1;
    // 触屏摇杆：按偏离原点的距离给"模拟量"（推一半就半速走），推满才满速
    if (touch.moveId !== null) {
      const ox = touch.mx - touch.ox, oy = touch.my - touch.oy;
      const dist = Math.hypot(ox, oy);
      if (dist > 6) {
        const amount = Math.min(1, dist / STICK.r);       // 0..1 的油门
        dx += (ox / dist) * amount;
        dy += (oy / dist) * amount;
      }
    }
    let len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; len = 1; }

    // 目标速度：有输入时朝着满速，没输入时是 0 —— 用指数逼近做出加速 / 阻尼滑行
    const tvx = dx * P.speed, tvy = dy * P.speed;
    const rate = len > 0.02 ? MOVE.accel : MOVE.damp;
    const k = 1 - Math.exp(-rate * dt);
    P.vx += (tvx - P.vx) * k;
    P.vy += (tvy - P.vy) * k;

    P.x = clamp(P.x + P.vx * dt, P.r, WORLD.w - P.r);
    P.y = clamp(P.y + P.vy * dt, P.r, WORLD.h - P.r);
    // 撞世界边界就把那个方向的速度吃掉；撞障碍物则被推出来、并吃掉一部分速度
    if (P.x <= P.r || P.x >= WORLD.w - P.r) P.vx = 0;
    if (P.y <= P.r || P.y >= WORLD.h - P.r) P.vy = 0;
    const fix = pushOut(P.x, P.y, P.r);
    if (fix.hit) { P.x = fix.x; P.y = fix.y; P.vx *= 0.35; P.vy *= 0.35; }

    // 滑行拖影：速度够快时留一串残影，让"惯性"看得见
    const sp = Math.hypot(P.vx, P.vy);
    P.trailT -= dt;
    if (sp > MOVE.trailSpeed && P.trailT <= 0) {
      P.trailT = 0.03;
      P.trail.push({ x: P.x, y: P.y, t: 0.22 });
    }
    for (let i = P.trail.length - 1; i >= 0; i--) {
      P.trail[i].t -= dt;
      if (P.trail[i].t <= 0) P.trail.splice(i, 1);
    }

    // 瞄准点用屏幕坐标给出（鼠标 / 按下的手指都写在 aimPoint 里），
    // 玩家是世界坐标 —— 先换算成世界坐标再算朝向（摄像机跟随之后必须这么做）
    const mwx = aimPoint.x + (S.cam.x - W / 2);
    const mwy = aimPoint.y + (S.cam.y - H / 2);
    P.aim = Math.atan2(mwy - P.y, mwx - P.x);
    P.cdLeft -= dt;
    const held = mouse.down || touch.aimId !== null;      // 点着不放 = 持续开火
    if (held && P.cdLeft <= 0) { shoot(); P.cdLeft = P.cooldown; }
    P.flash = Math.max(0, P.flash - dt);
    P.hurt = Math.max(0, P.hurt - dt);
  }

  function updateBullets(dt) {
    for (let i = S.bullets.length - 1; i >= 0; i--) {
      const b = S.bullets[i];
      b.x += b.vx * dt; b.y += b.vy * dt;
      b.life -= dt;
      if (b.life <= 0 || b.x < -20 || b.x > WORLD.w + 20 || b.y < -20 || b.y > WORLD.h + 20) {
        S.bullets.splice(i, 1); continue;
      }
      // 打在障碍物上就消失（墙能挡子弹）
      let blocked = false;
      for (let k = 0; k < S.obstacles.length; k++) {
        const o = S.obstacles[k];
        if (o.type === 'rect') {
          if (b.x > o.x && b.x < o.x + o.w && b.y > o.y && b.y < o.y + o.h) { blocked = true; break; }
        } else if (Math.hypot(b.x - o.x, b.y - o.y) < o.r + b.r) { blocked = true; break; }
      }
      if (blocked) { burst(b.x, b.y, 3); S.bullets.splice(i, 1); continue; }
      // 与敌人碰撞
      let hit = false;
      for (let j = 0; j < S.enemies.length; j++) {
        const e = S.enemies[j];
        if (e.dying > 0) continue;
        if (Math.hypot(e.x - b.x, e.y - b.y) <= e.r + b.r) {
          e.hp -= b.dmg;
          e.hitT = 0.08;
          burst(b.x, b.y, 4);
          beep(300, 0.04, 'square', 0.03);
          if (e.hp <= 0) killEnemy(e);
          if (b.pierce > 0) { b.pierce--; } else { hit = true; }
          break;
        }
      }
      if (hit) S.bullets.splice(i, 1);
    }
  }

  function killEnemy(e) {
    if (e.dying > 0) return;
    e.dying = 0.15;
    if (e.type !== 'boss') { S.kills++; gainXp(ENEMY[e.type].xp); }
    if (e.type === 'boss') {
      S.kills++; gainXp(ENEMY.boss.xp);
      S.rings.push({ x: e.x, y: e.y, r: 20, t: 0, max: 0.9 });
      beep(220, 0.35, 'sawtooth', 0.09);
    } else {
      beep(180, 0.07, 'sine', 0.04);
    }
    burst(e.x, e.y, 8);
  }

  function burst(x, y, n) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2), s = rand(40, 180);
      S.parts.push({ x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.12, 0.25), t: 0 });
    }
  }

  function updateEnemies(dt) {
    for (let i = S.enemies.length - 1; i >= 0; i--) {
      const e = S.enemies[i];
      if (e.dying > 0) {
        e.dying -= dt;
        if (e.dying <= 0) S.enemies.splice(i, 1);
        continue;
      }
      e.hitT = Math.max(0, e.hitT - dt);
      e.hitCd = Math.max(0, (e.hitCd || 0) - dt);   // 碰撞冷却必须递减，否则撞一次后永久失效
      const d = ENEMY[e.type];
      const dx = P.x - e.x, dy = P.y - e.y;
      const dist = Math.hypot(dx, dy) || 1;
      const baseA = Math.atan2(dy, dx);
      // 绕障碍：探针射线被挡就拐弯
      let aimA = steeringA(e, baseA);
      if (e.detourT > 0) {
        e.detourT -= dt;
        aimA = e.detourA;
      }
      const tvx = Math.cos(aimA) * d.speed, tvy = Math.sin(aimA) * d.speed;
      const kTurn = 1 - Math.exp(-(d.turn || 3.5) * dt);
      e.vx += (tvx - e.vx) * kTurn;
      e.vy += (tvy - e.vy) * kTurn;

      const ox = e.x, oy = e.y;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      const ef = pushOut(e.x, e.y, e.r);
      if (ef.hit) {
        e.x = ef.x;
        e.y = ef.y;
        // 沿墙滑：抵消朝墙（法线方向）的那部分速度，保留切线方向
        const nx = ef.x - ox, ny = ef.y - oy, nl = Math.hypot(nx, ny);
        if (nl > 0.001) {
          const ux = nx / nl, uy = ny / nl;
          const vn = e.vx * ux + e.vy * uy;
          if (vn < 0) { e.vx -= ux * vn; e.vy -= uy * vn; }
        }
        // 硬顶在墙上（切向速度也没了）就横着绕一段，别在原地磨
        if (e.detourT <= 0 && Math.hypot(e.vx, e.vy) < d.speed * 0.38) {
          e.detourA = baseA + (e.side || 1) * (Math.PI * 0.5);
          e.detourT = 0.7;
        }
      }
      e.x = clamp(e.x, e.r, WORLD.w - e.r);
      e.y = clamp(e.y, e.r, WORLD.h - e.r);
      if (dist <= e.r + P.r && e.hitCd <= 0) {
        // 撞到玩家：扣血 + 扣 1 点耐久，然后被弹开（不是一次性消失）
        hurtPlayer(d.dmg);
        e.hits -= 1;
        e.hitCd = 0.7;                     // 碰撞冷却，避免同一瞬间连撞好几次
        const nx = (e.x - P.x) / dist, ny = (e.y - P.y) / dist;
        e.vx = nx * d.speed * 1.7;          // 反方向弹开，靠转向迟滞再拐回来
        e.vy = ny * d.speed * 1.7;
        burst(e.x, e.y, 6);
        beep(200, 0.05, 'square', 0.03);
        if (e.hits <= 0) killEnemy(e);     // 耐久撞完才算击杀（计击杀数 + 给经验）
      }
    }
  }

  function updateParticles(dt) {
    for (let i = S.parts.length - 1; i >= 0; i--) {
      const p = S.parts[i];
      p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.96; p.vy *= 0.96;
      if (p.t >= p.life) S.parts.splice(i, 1);
    }
    for (let i = S.rings.length - 1; i >= 0; i--) {
      const r = S.rings[i];
      r.t += dt;
      if (r.t >= r.max) S.rings.splice(i, 1);
    }
  }

  // 护盾上限：跟着生命上限走（最大生命和"最大生命"升级会一起抬高它）
  function shieldMax() {
    return Math.max(10, Math.round(P.maxHp * HEALPACK.shieldShare));
  }

  // ---------- 回血包 / 护盾包 ----------
  function spawnPack(kind) {
    const m = 80;
    let x = 0, y = 0, tries = 0;
    do {
      x = rand(S.cam.x - W / 2 + m, S.cam.x + W / 2 - m);
      y = rand(S.cam.y - H / 2 + m, S.cam.y + H / 2 - m);
      tries++;
    } while ((Math.hypot(x - P.x, y - P.y) < 140 || pointBlocked(x, y, HEALPACK.r + 8)) && tries < 30);
    const k = kind || (Math.random() < HEALPACK.shieldChance ? 'shield' : 'heal');
    S.packs.push({ x: clamp(x, 30, WORLD.w - 30), y: clamp(y, 30, WORLD.h - 30),
                   kind: k, life: HEALPACK.life, bob: rand(0, Math.PI * 2) });
  }
  function updatePacks(dt) {
    // 每 every 秒掷一次骰子：chance 概率刷一个（场上最多 max 个）
    S.packT -= dt;
    if (S.packT <= 0) {
      S.packT = HEALPACK.every;
      if (S.packs.length < HEALPACK.max && Math.random() < HEALPACK.chance) spawnPack();
    }
    for (let i = S.packs.length - 1; i >= 0; i--) {
      const p = S.packs[i];
      p.life -= dt;
      p.bob += dt * 3;
      if (p.life <= 0) { S.packs.splice(i, 1); continue; }
      // 玩家踩上去就捡起
      if (Math.hypot(p.x - P.x, p.y - P.y) <= HEALPACK.r + P.r) {
        if (p.kind === 'shield') {
          const smax = shieldMax();
          if (P.shield >= smax) continue;          // 护盾满了：包留在原地，别浪费
          const before = P.shield;
          P.shield = Math.min(smax, P.shield + HEALPACK.shield);
          const got = Math.round(P.shield - before);
          S.packs.splice(i, 1);
          S.floats.push({ x: p.x, y: p.y - 18, text: '+' + got + ' 盾', t: 0, color: '#8fd0ff' });
          S.rings.push({ x: p.x, y: p.y, r: 8, t: 0, max: 0.45, color: '#5ad1ff' });
          burst(p.x, p.y, 10);
          beep(620, 0.12, 'triangle', 0.05);
        } else {
          const before = P.hp;
          P.hp = Math.min(P.maxHp, P.hp + HEALPACK.heal);
          const got = Math.round(P.hp - before);
          S.packs.splice(i, 1);
          S.floats.push({ x: p.x, y: p.y - 18, text: '+' + got, t: 0 });
          S.rings.push({ x: p.x, y: p.y, r: 8, t: 0, max: 0.45, color: '#3ddc97' });
          burst(p.x, p.y, 10);
          beep(760, 0.12, 'triangle', 0.05);
        }
      }
    }
    for (let i = S.floats.length - 1; i >= 0; i--) {
      const f = S.floats[i];
      f.t += dt;
      f.y -= dt * 42;
      if (f.t >= 0.9) S.floats.splice(i, 1);
    }
  }
  function drawPacks() {
    for (let i = 0; i < S.packs.length; i++) {
      const p = S.packs[i];
      if (!inView(p.x, p.y, 60)) continue;
      const isShield = p.kind === 'shield';
      const pulse = 1 + Math.sin(p.bob) * 0.07;
      // 快消失时闪烁提醒
      const fade = p.life < 3 ? 0.45 + 0.55 * Math.abs(Math.sin(p.life * 8)) : 1;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, p.y);
      ctx.scale(pulse, pulse);
      const R = HEALPACK.r;
      const glow = ctx.createRadialGradient(0, 0, 2, 0, 0, R * 2);
      glow.addColorStop(0, isShield ? 'rgba(90,209,255,.34)' : 'rgba(61,220,151,.34)');
      glow.addColorStop(1, isShield ? 'rgba(90,209,255,0)' : 'rgba(61,220,151,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, R * 2, 0, Math.PI * 2);
      ctx.fill();
      if (isShield) {
        // 护盾包：六边形盾牌 + 中间一道竖线
        ctx.beginPath();
        ctx.moveTo(0, -R);
        ctx.lineTo(R * 0.9, -R * 0.42);
        ctx.lineTo(R * 0.9, R * 0.34);
        ctx.lineTo(0, R);
        ctx.lineTo(-R * 0.9, R * 0.34);
        ctx.lineTo(-R * 0.9, -R * 0.42);
        ctx.closePath();
        ctx.fillStyle = '#2f7fd6';
        ctx.fill();
        ctx.strokeStyle = 'rgba(190,235,255,.9)';
        ctx.lineWidth = 1.8;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(220,245,255,.75)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(0, -R * 0.6);
        ctx.lineTo(0, R * 0.6);
        ctx.stroke();
      } else {
        // 回血包：绿色十字
        const t = R * 0.68;
        ctx.fillStyle = '#20c46e';
        roundRect(-R, -t / 2, R * 2, t, 4); ctx.fill();
        roundRect(-t / 2, -R, t, R * 2, 4); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.72)';
        ctx.lineWidth = 1.5;
        roundRect(-R, -t / 2, R * 2, t, 4); ctx.stroke();
        roundRect(-t / 2, -R, t, R * 2, 4); ctx.stroke();
      }
      ctx.restore();
    }
  }
  function drawFloats() {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = '700 20px "PingFang SC","Microsoft YaHei",sans-serif';
    for (let i = 0; i < S.floats.length; i++) {
      const f = S.floats[i];
      ctx.globalAlpha = Math.max(0, 1 - f.t / 0.9);
      ctx.fillStyle = f.color || '#3ddc97';
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.restore();
  }

  function updateWaves(dt) {
    if (S.state === 'break') {
      S.breakT -= dt;
      if (S.breakT <= 0) { startWave(Math.min(S.wave + 1, WAVE.length)); }
      return;
    }
    if (S.state !== 'playing') return;
    S.waveTime -= dt;
    const cfg = WAVE[Math.min(S.wave, WAVE.length) - 1];
    S.spawnT -= dt;
    if (S.waveTime > 0 && S.spawnT <= 0) {
      S.spawnT = cfg.interval;
      spawnFromMix(cfg.mix);
    }
    if (S.waveTime <= 0) {
      if (S.wave >= WAVE.length) {
        S.state = 'win';
        if (S.elapsed > S.best) {
          S.best = S.elapsed;
          try { localStorage.setItem('sp-best-elapsed', String(S.best)); } catch (e) { /* ignore */ }
        }
        S.banner = { text: '你活下来了', t: 2 };
        beep(880, 0.3, 'triangle', 0.07);
      } else {
        S.state = 'break';
        S.breakT = 3;
        S.banner = { text: '第 ' + (S.wave + 1) + ' 波 · 准备', t: 1.2 };
      }
    }
  }

  // 摄像机平滑跟随玩家，并把视口夹在世界里（贴到地图边时不会露出世界外）
  function updateCamera(dt) {
    const k = 1 - Math.exp(-9 * dt);
    S.cam.x += (P.x - S.cam.x) * k;
    S.cam.y += (P.y - S.cam.y) * k;
    S.cam.x = clamp(S.cam.x, W / 2, WORLD.w - W / 2);
    S.cam.y = clamp(S.cam.y, H / 2, WORLD.h - H / 2);
  }

  function update(dt) {
    S.t += dt;
    if (S.banner) { S.banner.t -= dt; if (S.banner.t <= 0) S.banner = null; }
    S.levelFx = Math.max(0, S.levelFx - dt);
    S.shake = Math.max(0, S.shake - dt * 32);
    if (S.state === 'playing' || S.state === 'break') {
      S.elapsed += dt;
      updatePlayer(dt);
      updateBullets(dt);
      updateEnemies(dt);
      updatePacks(dt);
      updateWaves(dt);
      updateCamera(dt);
    }
    updateParticles(dt);
  }

  // ==================== 绘制 ====================
  function drawBackground() {
    // 只画视口范围内那一小片（世界是 3200x2400，全画没必要）
    const x0 = Math.floor((S.cam.x - W / 2) / 64) * 64, x1 = S.cam.x + W / 2;
    const y0 = Math.floor((S.cam.y - H / 2) / 64) * 64, y1 = S.cam.y + H / 2;
    const g = ctx.createRadialGradient(S.cam.x, S.cam.y, 100, S.cam.x, S.cam.y, Math.max(W, H) * 0.9);
    g.addColorStop(0, '#111a26');
    g.addColorStop(1, '#070a0f');
    ctx.fillStyle = g;
    ctx.fillRect(x0 - 80, y0 - 80, (x1 - x0) + 160, (y1 - y0) + 160);
    ctx.save();
    ctx.strokeStyle = 'rgba(120,150,200,.07)';
    ctx.lineWidth = 1;
    for (let x = x0; x <= x1; x += 64) {
      ctx.beginPath(); ctx.moveTo(x, y0 - 80); ctx.lineTo(x, y1 + 80); ctx.stroke();
    }
    for (let y = y0; y <= y1; y += 64) {
      ctx.beginPath(); ctx.moveTo(x0 - 80, y); ctx.lineTo(x1 + 80, y); ctx.stroke();
    }
    // 世界边框：走到地图边上能看见
    ctx.strokeStyle = 'rgba(120,170,255,.32)';
    ctx.lineWidth = 6;
    ctx.strokeRect(0, 0, WORLD.w, WORLD.h);
    ctx.restore();
  }

  // 障碍物：矩形 = 墙/箱子，圆 = 石头（挡人、挡子弹、挡怪）
  function drawObstacles() {
    for (let i = 0; i < S.obstacles.length; i++) {
      const o = S.obstacles[i];
      if (o.type === 'rect') {
        if (!inView(o.x + o.w / 2, o.y + o.h / 2, Math.max(o.w, o.h))) continue;
        ctx.save();
        ctx.fillStyle = '#1b2634';
        ctx.strokeStyle = '#33465e';
        ctx.lineWidth = 3;
        roundRect(o.x, o.y, o.w, o.h, 10);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = 'rgba(120,170,255,.06)';
        roundRect(o.x + 5, o.y + 5, o.w - 10, Math.min(16, o.h - 10), 6);
        ctx.fill();
        ctx.restore();
      } else {
        if (!inView(o.x, o.y, o.r)) continue;
        ctx.save();
        const g = ctx.createRadialGradient(o.x - o.r * 0.3, o.y - o.r * 0.35, o.r * 0.15, o.x, o.y, o.r);
        g.addColorStop(0, '#2b3b50');
        g.addColorStop(1, '#131c27');
        ctx.beginPath();
        ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
        ctx.strokeStyle = '#33465e';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  function drawPlayer() {
    // 滑动拖影（速度越快越明显，让"惯性"看得见）
    for (let i = 0; i < P.trail.length; i++) {
      const q = P.trail[i];
      const a = Math.max(0, q.t / 0.22);
      ctx.save();
      ctx.globalAlpha = a * 0.28;
      ctx.beginPath();
      ctx.arc(q.x, q.y, P.r * (0.45 + 0.55 * a), 0, Math.PI * 2);
      ctx.fillStyle = '#57a0ff';
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    ctx.translate(P.x, P.y);
    // 枪管
    ctx.rotate(P.aim);
    ctx.strokeStyle = P.flash > 0 ? '#ffffff' : '#9fc2ff';
    ctx.lineWidth = P.flash > 0 ? 6 : 4;
    ctx.beginPath();
    ctx.moveTo(P.r - 2, 0);
    ctx.lineTo(P.r + (P.flash > 0 ? 16 : 10), 0);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.translate(P.x, P.y);
    const grad = ctx.createRadialGradient(-4, -5, 2, 0, 0, P.r);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.5, '#57a0ff');
    grad.addColorStop(1, '#1d5fd6');
    ctx.beginPath();
    ctx.arc(0, 0, P.r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  function drawEnemy(e) {
    if (!inView(e.x, e.y, e.r + 40)) return;   // 视野外的敌人不画
    const d = ENEMY[e.type];
    const dying = e.dying > 0;
    const k = dying ? 1 + (0.15 - e.dying) / 0.15 * 0.8 : 1;
    const alpha = dying ? Math.max(0, e.dying / 0.15) : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(e.x, e.y);
    ctx.scale(k, k);
    ctx.beginPath();
    const r = e.r;
    if (d.shape === 'tri') {
      ctx.moveTo(0, -r); ctx.lineTo(r * 0.92, r * 0.75); ctx.lineTo(-r * 0.92, r * 0.75); ctx.closePath();
    } else if (d.shape === 'square') {
      ctx.rect(-r, -r, r * 2, r * 2);
    } else if (d.shape === 'hex') {
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 3 * i - Math.PI / 6;
        const px = Math.cos(a) * r, py = Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
    } else {
      ctx.arc(0, 0, r, 0, Math.PI * 2);
    }
    ctx.fillStyle = dying ? '#ffffff' : (e.hitT > 0 ? '#ffffff' : d.color);
    ctx.fill();
    if (d.stroke) { ctx.strokeStyle = d.stroke; ctx.lineWidth = 3; ctx.stroke(); }
    ctx.restore();
    // 剩余耐久：还要撞玩家几次才消失（小圆点，撞一次灭一个）
    if (!dying) {
      const total = ENEMY[e.type].hits || 1;
      for (let i = 0; i < total; i++) {
        const px = e.x - (total - 1) * 5 + i * 10;
        const py = e.y + e.r + 11;
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fillStyle = i < e.hits ? 'rgba(255,110,110,.95)' : 'rgba(255,255,255,.16)';
        ctx.fill();
      }
    }
    // Boss 血条
    if (e.type === 'boss' && !dying) {
      const w = 120;
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(e.x - w / 2, e.y - e.r - 18, w, 8);
      ctx.fillStyle = '#ff4d6d';
      ctx.fillRect(e.x - w / 2, e.y - e.r - 18, w * Math.max(0, e.hp / e.maxHp), 8);
      ctx.restore();
    }
  }

  // 右上角小地图：全世界缩略 + 障碍物 + 敌人红点 + 回血包绿点 + 视野框 + 玩家
  function drawMinimap() {
    const mw = 200, mh = 150, mx = W - 24 - mw, my = 16;
    const sx = mw / WORLD.w, sy = mh / WORLD.h;
    ctx.save();
    // 卡片底
    ctx.fillStyle = 'rgba(8,12,18,.62)';
    roundRect(mx - 8, my - 8, mw + 16, mh + 16, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,170,255,.28)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // 只在小地图范围内画
    ctx.beginPath();
    ctx.rect(mx, my, mw, mh);
    ctx.clip();
    ctx.fillStyle = 'rgba(20,30,44,.92)';
    ctx.fillRect(mx, my, mw, mh);
    // 障碍物
    ctx.fillStyle = 'rgba(70,96,128,.9)';
    for (let i = 0; i < S.obstacles.length; i++) {
      const o = S.obstacles[i];
      if (o.type === 'rect') {
        ctx.fillRect(mx + o.x * sx, my + o.y * sy, Math.max(2, o.w * sx), Math.max(2, o.h * sy));
      } else {
        ctx.beginPath();
        ctx.arc(mx + o.x * sx, my + o.y * sy, Math.max(1.5, o.r * sx), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // 回血包
    ctx.fillStyle = '#3ddc97';
    for (let i = 0; i < S.packs.length; i++) {
      const p = S.packs[i];
      ctx.fillStyle = p.kind === 'shield' ? '#5ad1ff' : '#3ddc97';
      ctx.beginPath();
      ctx.arc(mx + p.x * sx, my + p.y * sy, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    // 敌人
    ctx.fillStyle = '#ff5c5c';
    for (let i = 0; i < S.enemies.length; i++) {
      const e = S.enemies[i];
      if (e.dying > 0) continue;
      ctx.beginPath();
      ctx.arc(mx + e.x * sx, my + e.y * sy, e.type === 'boss' ? 4 : 2, 0, Math.PI * 2);
      ctx.fill();
    }
    // 当前视野框
    ctx.strokeStyle = 'rgba(255,255,255,.38)';
    ctx.lineWidth = 1;
    ctx.strokeRect(mx + (S.cam.x - W / 2) * sx, my + (S.cam.y - H / 2) * sy,
                   W * sx, H * sy);
    // 玩家（带朝向短线）
    const px = mx + P.x * sx, py = my + P.y * sy;
    ctx.fillStyle = '#8fd0ff';
    ctx.beginPath();
    ctx.arc(px, py, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#8fd0ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.cos(P.aim) * 7, py + Math.sin(P.aim) * 7);
    ctx.stroke();
    ctx.restore();
  }

  function drawHud() {
    drawMinimap();
    // 左上：护盾条（压在生命条上面）+ 生命
    const sMax = shieldMax();
    ctx.save();
    ctx.fillStyle = 'rgba(8,12,18,.55)';
    roundRect(18, 12, 316, 84, 10);
    ctx.fill();
    ctx.restore();
    // 护盾
    ctx.fillStyle = 'rgba(255,255,255,.12)';
    ctx.fillRect(34, 22, 214, 10);
    ctx.fillStyle = '#5ad1ff';
    ctx.fillRect(34, 22, 214 * Math.max(0, Math.min(1, P.shield / sMax)), 10);
    ctx.textAlign = 'right';
    ctx.font = '700 12px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#8fd0ff';
    ctx.fillText('🛡 ' + Math.round(P.shield) + ' / ' + sMax, 316, 31);
    // 生命
    ctx.fillStyle = '#ff6b81';
    heartPath(42, 58, 10);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.14)';
    ctx.fillRect(60, 50, 190, 16);
    ctx.fillStyle = '#ff5c7a';
    ctx.fillRect(60, 50, 190 * Math.max(0, P.hp / P.maxHp), 16);
    ctx.textAlign = 'right';
    ctx.font = '700 14px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#fff';
    ctx.fillText(Math.ceil(P.hp) + ' / ' + P.maxHp, 316, 64);
    ctx.textAlign = 'left';
    ctx.font = '600 11px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#9fb6d6';
    ctx.fillText('❤ 生命', 60, 44);

    // 顶部中央：波次
    ctx.textAlign = 'center';
    ctx.font = '700 22px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#e8f0ff';
    ctx.fillText('第 ' + S.wave + ' 波', W / 2, 42);

    // 右上：计时（挪到小地图下面，避免与它重叠）
    ctx.textAlign = 'right';
    ctx.font = '700 20px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = S.waveTime < 5 ? '#ffd166' : '#cfe0ff';
    ctx.fillText('⏱ ' + Math.max(0, Math.ceil(S.waveTime)) + 's', W - 24, 208);
    ctx.font = '500 12px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#6c86a8';
    ctx.fillText('存活 ' + fmt(S.elapsed), W - 24, 228);

    // 左下：等级 + 经验条
    ctx.textAlign = 'left';
    ctx.font = '700 16px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#ffd166';
    ctx.fillText('Lv.' + P.level, 24, H - 34);
    ctx.fillStyle = 'rgba(255,255,255,.12)';
    ctx.fillRect(78, H - 46, 300, 14);
    ctx.fillStyle = '#5ad1ff';
    ctx.fillRect(78, H - 46, 300 * Math.max(0, P.xp / P.xpNext), 14);
    ctx.fillStyle = '#8fa6c6';
    ctx.font = '600 12px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillText(P.xp + ' / ' + P.xpNext, 388, H - 34);

    // 击杀数
    ctx.textAlign = 'right';
    ctx.fillStyle = '#6c86a8';
    ctx.font = '600 13px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillText('击杀 ' + S.kills + ' · 历史最长 ' + fmt(S.best), W - 24, H - 34);

    // 受伤红晕
    if (P.hurt > 0) {
      const a = P.hurt / 0.2 * 0.45;
      const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.75);
      g.addColorStop(0, 'rgba(255,0,0,0)');
      g.addColorStop(1, 'rgba(255,0,0,' + a + ')');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    // 升级金环
    if (S.levelFx > 0) {
      ctx.save();
      ctx.globalAlpha = S.levelFx / 0.5;
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(P.x, P.y, 30 + (0.5 - S.levelFx) * 320, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    // 波次横幅
    if (S.banner) {
      const a = Math.min(1, S.banner.t / 0.4);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.textAlign = 'center';
      ctx.font = '800 40px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillStyle = 'rgba(0,0,0,.5)';
      ctx.fillText(S.banner.text, W / 2 + 2, H / 2 - 128);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(S.banner.text, W / 2, H / 2 - 130);
      ctx.restore();
    }
    drawGear();     // 左上角 ⚙：手机模式 / 音效 的开关入口
  }

  // ==================== 触屏界面（摇杆 / 准星 / 顶栏按钮） ====================
  function goFullscreen() {
    const el = document.documentElement;
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        return;
      }
      if (el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(function () {});
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    } catch (e) { /* iPhone 的 Safari 不支持元素全屏，忽略就好 */ }
    // 横屏锁屏：只在支持的地方生效（安卓 Chrome / 部分浏览器）
    try {
      if (screen.orientation && screen.orientation.lock) {
        const r = screen.orientation.lock('landscape');
        if (r && r.catch) r.catch(function () {});
      }
    } catch (e) { /* 忽略 */ }
  }

  // 顶栏三个按钮（暂停 / 静音 / 全屏）：每帧重建，位置跟着 HUD 走
  function touchButtons() {
    const w = 56, h = 40, gap = 8, y = 246;
    let x = W - 24 - w;
    const list = [];
    list.push({ id: 'full', x: x, y: y, w: w, h: h, fn: goFullscreen });
    x -= w + gap;
    list.push({ id: 'mute', x: x, y: y, w: w, h: h, on: S.muted,
                fn: function () { S.muted = !S.muted; } });
    x -= w + gap;
    const paused = S.state === 'paused';
    list.push({ id: 'pause', x: x, y: y, w: w, h: h, on: paused,
                fn: function () {
                  if (S.state === 'paused') { S.state = S.pauseReturn || 'playing'; }
                  else if (S.state === 'playing' || S.state === 'break') {
                    S.pauseReturn = S.state;
                    S.state = 'paused';
                  }
                } });
    return list;
  }
  function hitTouchButton(p) {
    const list = touchButtons();
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      // 手指比鼠标粗，命中框外扩一圈
      if (hitRect(p.x, p.y, b.x - 6, b.y - 6, b.w + 12, b.h + 12)) return b;
    }
    return null;
  }

  function drawTouchUi() {
    const playing = S.state === 'playing' || S.state === 'break' || S.state === 'paused';

    // --- 左手摇杆 ---
    if (playing) {
      const active = touch.moveId !== null;
      const ox = active ? touch.ox : STICK.x;
      const oy = active ? touch.oy : STICK.y;
      ctx.save();
      ctx.globalAlpha = active ? 0.9 : 0.30;
      // 底盘
      ctx.beginPath();
      ctx.arc(ox, oy, STICK.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(10,16,26,.45)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,170,255,.7)';
      ctx.lineWidth = 2;
      ctx.stroke();
      // 摇杆头
      let kx = ox, ky = oy;
      if (active) {
        const vx = touch.mx - touch.ox, vy = touch.my - touch.oy;
        const d = Math.hypot(vx, vy);
        const capD = Math.min(d, STICK.r);
        if (d > 0.001) { kx = ox + (vx / d) * capD; ky = oy + (vy / d) * capD; }
      }
      ctx.beginPath();
      ctx.arc(kx, ky, STICK.knob, 0, Math.PI * 2);
      ctx.fillStyle = active ? 'rgba(143,208,255,.55)' : 'rgba(143,208,255,.30)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(200,230,255,.85)';
      ctx.lineWidth = 2;
      ctx.stroke();
      if (!active) {
        ctx.globalAlpha = 0.5;
        ctx.textAlign = 'center';
        ctx.font = '600 13px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx.fillStyle = '#a9c4e6';
        ctx.fillText('拖动移动', ox, oy + 4);
      }
      ctx.restore();
    }

    // --- 右手瞄准点：按着的地方画个准星，顺便把射线拖出来 ---
    if (playing && touch.aimId !== null) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,209,102,.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(touch.ax, touch.ay, 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(touch.ax - 24, touch.ay); ctx.lineTo(touch.ax - 8, touch.ay);
      ctx.moveTo(touch.ax + 8, touch.ay); ctx.lineTo(touch.ax + 24, touch.ay);
      ctx.moveTo(touch.ax, touch.ay - 24); ctx.lineTo(touch.ax, touch.ay - 8);
      ctx.moveTo(touch.ax, touch.ay + 8); ctx.lineTo(touch.ax, touch.ay + 24);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,209,102,.9)';
      ctx.beginPath();
      ctx.arc(touch.ax, touch.ay, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // --- 顶栏按钮 ---
    if (playing) {
      const list = touchButtons();
      for (let i = 0; i < list.length; i++) drawTouchButton(list[i]);
    }

    // --- 开局提示 ---
    if (playing && touch.hint > 0) {
      const a = Math.min(1, touch.hint / 1.2) * 0.9;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.textAlign = 'center';
      ctx.font = '700 17px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillStyle = 'rgba(8,12,18,.62)';
      roundRect(W / 2 - 250, H - 132, 500, 44, 12);
      ctx.fill();
      ctx.fillStyle = '#dbe9ff';
      ctx.fillText('左下拖动走位 · 按住屏幕任意处朝那个点开枪', W / 2, H - 103);
      ctx.restore();
    }
  }

  function drawTouchButton(b) {
    ctx.save();
    ctx.fillStyle = b.on ? 'rgba(90,160,255,.35)' : 'rgba(8,12,18,.55)';
    roundRect(b.x, b.y, b.w, b.h, 10);
    ctx.fill();
    ctx.strokeStyle = b.on ? 'rgba(150,200,255,.9)' : 'rgba(120,170,255,.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    ctx.strokeStyle = '#cfe0ff';
    ctx.fillStyle = '#cfe0ff';
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (b.id === 'pause') {
      if (b.on) {                                  // ▶
        ctx.moveTo(cx - 6, cy - 9); ctx.lineTo(cx + 9, cy); ctx.lineTo(cx - 6, cy + 9);
        ctx.closePath(); ctx.fill();
      } else {                                     // ⏸
        ctx.moveTo(cx - 6, cy - 9); ctx.lineTo(cx - 6, cy + 9);
        ctx.moveTo(cx + 6, cy - 9); ctx.lineTo(cx + 6, cy + 9);
        ctx.stroke();
      }
    } else if (b.id === 'mute') {                   // 喇叭 +（静音时）一道斜杠
      ctx.moveTo(cx - 10, cy - 4); ctx.lineTo(cx - 4, cy - 4);
      ctx.lineTo(cx + 3, cy - 10); ctx.lineTo(cx + 3, cy + 10);
      ctx.lineTo(cx - 4, cy + 4); ctx.lineTo(cx - 10, cy + 4);
      ctx.closePath();
      ctx.stroke();
      if (b.on) {
        ctx.beginPath();
        ctx.moveTo(cx + 7, cy - 7); ctx.lineTo(cx + 15, cy + 7);
        ctx.moveTo(cx + 15, cy - 7); ctx.lineTo(cx + 7, cy + 7);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(cx + 4, cy, 8, -0.9, 0.9);
        ctx.stroke();
      }
    } else {                                        // 全屏：四个角
      const a = 7, e = 13;
      ctx.moveTo(cx - e, cy - e + a); ctx.lineTo(cx - e, cy - e); ctx.lineTo(cx - e + a, cy - e);
      ctx.moveTo(cx + e - a, cy - e); ctx.lineTo(cx + e, cy - e); ctx.lineTo(cx + e, cy - e + a);
      ctx.moveTo(cx + e, cy + e - a); ctx.lineTo(cx + e, cy + e); ctx.lineTo(cx + e - a, cy + e);
      ctx.moveTo(cx - e + a, cy + e); ctx.lineTo(cx - e, cy + e); ctx.lineTo(cx - e, cy + e - a);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ==================== 设置面板（左上角 ⚙） ====================
  // 现在只有两项：手机模式（触屏摇杆 / 点哪打哪）和音效。
  // 打开面板时世界冻结 —— 不然玩家在菜单里被怪打死，那是设计事故。
  const GEAR = { x: 18, y: 104, w: 40, h: 40 };
  const GEAR_HIT = { x: GEAR.x, y: GEAR.y, w: GEAR.w, h: GEAR.h };
  function inBox(p, b) {
    return hitRect(p.x, p.y, b.x - 6, b.y - 6, b.w + 12, b.h + 12);
  }
  function settingsLayout() {
    const w = 540, h = 272;
    const x = (W - w) / 2, y = (H - h) / 2;
    return {
      x: x, y: y, w: w, h: h,
      mobile: { x: x + w - 110, y: y + 74, w: 70, h: 36 },
      sound: { x: x + w - 110, y: y + 140, w: 70, h: 36 },
      close: { x: x + w / 2 - 76, y: y + h - 64, w: 152, h: 44 },
    };
  }
  function drawToggle(b, on) {
    ctx.save();
    ctx.fillStyle = on ? 'rgba(90,160,255,.9)' : 'rgba(255,255,255,.14)';
    roundRect(b.x, b.y, b.w, b.h, b.h / 2);
    ctx.fill();
    ctx.strokeStyle = on ? 'rgba(180,220,255,.95)' : 'rgba(150,175,210,.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    const r = b.h / 2 - 4;
    const cx = on ? b.x + b.w - b.h / 2 : b.x + b.h / 2;
    ctx.beginPath();
    ctx.arc(cx, b.y + b.h / 2, r, 0, Math.PI * 2);
    ctx.fillStyle = on ? '#fff' : '#9fb6d6';
    ctx.fill();
    // ON / OFF 字样贴在开关另一侧
    ctx.font = '700 11px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = on ? '#dff0ff' : '#7f93ad';
    ctx.textAlign = on ? 'right' : 'left';
    ctx.fillText(on ? 'ON' : 'OFF', on ? b.x - 8 : b.x + b.w + 8, b.y + b.h / 2 + 4);
    ctx.restore();
  }
  function drawGear() {
    const cx = GEAR.x + GEAR.w / 2, cy = GEAR.y + GEAR.h / 2;
    ctx.save();
    ctx.fillStyle = 'rgba(8,12,18,.55)';
    roundRect(GEAR.x, GEAR.y, GEAR.w, GEAR.h, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,170,255,.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // 齿轮：8 颗齿 + 内外两圈
    ctx.strokeStyle = S.settings ? '#ffd166' : '#a9c4e6';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 11, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * 11, cy + Math.sin(a) * 11);
      ctx.lineTo(cx + Math.cos(a) * 15, cy + Math.sin(a) * 15);
      ctx.stroke();
    }
    ctx.restore();
  }
  function drawSettings() {
    const L = settingsLayout();
    ctx.save();
    ctx.fillStyle = 'rgba(4,7,12,.74)';
    ctx.fillRect(0, 0, W, H);
    // 卡片
    ctx.fillStyle = 'rgba(10,16,26,.96)';
    roundRect(L.x, L.y, L.w, L.h, 16);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,170,255,.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // 标题
    ctx.textAlign = 'left';
    ctx.font = '800 24px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#e8f0ff';
    ctx.fillText('设置', L.x + 28, L.y + 44);
    ctx.strokeStyle = 'rgba(255,255,255,.10)';
    ctx.beginPath();
    ctx.moveTo(L.x + 24, L.y + 60);
    ctx.lineTo(L.x + L.w - 24, L.y + 60);
    ctx.stroke();
    // 行 1：手机模式
    ctx.font = '700 17px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#dbe9ff';
    ctx.fillText('手机模式', L.x + 28, L.y + 98);
    ctx.font = '500 13px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#8fa6c6';
    ctx.fillText('左侧虚拟摇杆 + 右手点哪打哪（触屏设备默认开）', L.x + 28, L.y + 126);
    drawToggle(L.mobile, MOBILE);
    // 行 2：音效
    ctx.font = '700 17px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#dbe9ff';
    ctx.fillText('音效', L.x + 28, L.y + 164);
    ctx.font = '500 13px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#8fa6c6';
    ctx.fillText('WebAudio 现场合成，没有音频文件', L.x + 28, L.y + 192);
    drawToggle(L.sound, !S.muted);
    // 关掉手机模式时给一句人话，免得读者以为"功能没了"
    ctx.font = '500 12px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#6c86a8';
    ctx.fillText(MOBILE ? '当前：手机模式（触屏可用）' : '当前：键鼠模式（触屏 UI 已隐藏）',
                 L.x + 28, L.y + 218);
    // 关闭按钮
    ctx.fillStyle = 'rgba(90,160,255,.22)';
    roundRect(L.close.x, L.close.y, L.close.w, L.close.h, 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(150,200,255,.6)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.font = '700 17px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#dbe9ff';
    ctx.fillText('关闭', L.close.x + L.close.w / 2, L.close.y + 29);
    ctx.restore();
  }

  function heartPath(x, y, r) {
    ctx.beginPath();
    ctx.moveTo(x, y + r * 0.9);
    ctx.bezierCurveTo(x - r * 1.6, y - r * 0.2, x - r * 0.6, y - r * 1.4, x, y - r * 0.5);
    ctx.bezierCurveTo(x + r * 0.6, y - r * 1.4, x + r * 1.6, y - r * 0.2, x, y + r * 0.9);
    ctx.closePath();
  }

  function drawTitle() {
    ctx.textAlign = 'center';
    ctx.font = '800 64px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#eaf2ff';
    ctx.fillText('幸存者协议', W / 2, H / 2 - 130);
    ctx.font = '700 20px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#7fb2ff';
    ctx.fillText('SURVIVOR PROTOCOL · 波次生存原型', W / 2, H / 2 - 92);
    ctx.font = '500 16px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#9fb6d6';
    ctx.fillText('WASD 移动 · 鼠标瞄准 · 左键射击 · Esc 暂停 · M 静音 · R 重开', W / 2, H / 2 - 30);
    ctx.fillText('活过 10 波：击杀敌人攒经验，升级时三选一强化', W / 2, H / 2 + 2);
    ctx.font = '600 14px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#5b6f8f';
    ctx.fillText('历史最长存活 ' + fmt(S.best), W / 2, H / 2 + 40);
    button('开始游戏', W / 2 - 110, H / 2 + 78, 220, 56);
    // 标题界面也能进设置（手机上开局前就能确认手机模式是开的）
    ctx.font = '500 13px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#5b6f8f';
    ctx.fillText(MOBILE ? '当前：手机模式（左手摇杆 · 右手点哪打哪）' : '当前：键鼠模式（左上角 ⚙ 可切到手机模式）',
                 W / 2, H / 2 + 168);
    drawGear();
  }

  function drawUpgrade() {
    ctx.save();
    ctx.fillStyle = 'rgba(4,7,12,.78)';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    ctx.textAlign = 'center';
    ctx.font = '800 30px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#fff';
    ctx.fillText('选择一项强化', W / 2, 168);
    ctx.font = '500 14px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#8fa6c6';
    ctx.fillText('Lv.' + P.level + ' · 还剩 ' + S.pendingLevels + ' 次升级', W / 2, 196);

    const cw = 300, gap = 30, total = cw * 3 + gap * 2;
    const x0 = (W - total) / 2;
    for (let i = 0; i < S.choices.length; i++) {
      const u = S.choices[i];
      const x = x0 + i * (cw + gap), y = 236, h = 300;
      const hov = hitRect(mouse.x, mouse.y, x, y, cw, h);
      ctx.save();
      roundRect(x, y, cw, h, 16);
      ctx.fillStyle = hov ? 'rgba(61,123,255,.22)' : 'rgba(255,255,255,.05)';
      ctx.fill();
      ctx.strokeStyle = hov ? '#6aa8ff' : 'rgba(255,255,255,.12)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
      ctx.textAlign = 'center';
      ctx.font = '800 44px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillStyle = '#ffd166';
      ctx.fillText(u.icon, x + cw / 2, y + 92);
      ctx.font = '700 22px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillStyle = '#eaf2ff';
      ctx.fillText(u.name, x + cw / 2, y + 146);
      ctx.font = '500 15px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillStyle = '#9fb6d6';
      wrapText(u.desc, x + cw / 2, y + 182, cw - 50, 24);
      ctx.textAlign = 'center';
      ctx.font = '700 16px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillStyle = hov ? '#ffffff' : '#8fc0ff';
      ctx.fillText('[ 选择 ]', x + cw / 2, y + h - 24);
      S.choices[i]._rect = { x: x, y: y, w: cw, h: h };
    }
  }

  function drawEnd(win) {
    ctx.save();
    ctx.fillStyle = 'rgba(4,7,12,.82)';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    ctx.textAlign = 'center';
    ctx.font = '800 52px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = win ? '#3ddc97' : '#ff6b81';
    ctx.fillText(win ? '你活下来了' : '你死了', W / 2, 220);
    ctx.font = '600 20px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#dbe6f7';
    ctx.fillText('存活时间：' + fmt(S.elapsed), W / 2, 286);
    ctx.fillText('击杀数：' + S.kills, W / 2, 320);
    ctx.fillText(win ? '最终等级：Lv.' + P.level : '到达波次：第 ' + S.wave + ' 波', W / 2, 354);
    ctx.font = '500 14px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#6c86a8';
    ctx.fillText('历史最长存活 ' + fmt(S.best), W / 2, 394);
    button('按 R 重新开始', W / 2 - 130, 430, 260, 56);
  }

  // ==================== 小部件 ====================
  function button(label, x, y, w, h) {
    const hov = hitRect(mouse.x, mouse.y, x, y, w, h);
    ctx.save();
    roundRect(x, y, w, h, 12);
    ctx.fillStyle = hov ? '#3d7bff' : '#1d6ef0';
    ctx.fill();
    ctx.restore();
    ctx.textAlign = 'center';
    ctx.font = '700 20px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + w / 2, y + h / 2 + 7);
    S._btn = { x: x, y: y, w: w, h: h };
  }
  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function hitRect(px, py, x, y, w, h) {
    return px >= x && px <= x + w && py >= y && py <= y + h;
  }
  function wrapText(s, cx, y, maxW, lh) {
    const chars = String(s).split('');
    let line = '';
    for (let i = 0; i < chars.length; i++) {
      const test = line + chars[i];
      if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, cx, y); y += lh; line = chars[i]; }
      else line = test;
    }
    if (line) ctx.fillText(line, cx, y);
  }
  function fmt(sec) {
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ==================== 主循环 ====================
  let lastT = 0;
  function frame(now) {
    if (!lastT) lastT = now;
    let dt = (now - lastT) / 1000;
    lastT = now;
    dt = Math.min(0.05, Math.max(0, dt));

    if (S.settings) {
      // 设置面板打开时冻结整个世界：菜单里被怪打死是最亏的死法
    } else if (S.state === 'playing' || S.state === 'break') update(dt);
    else {
      S.t += dt;
      if (S.banner) { S.banner.t -= dt; if (S.banner.t <= 0) S.banner = null; }
      updateParticles(dt);
    }
    if (touch.hint > 0) touch.hint -= dt;     // 开局操作提示的倒计时（暂停时也照常走）

    ctx.save();
    if (S.shake > 0) ctx.translate(rand(-S.shake, S.shake) * 0.5, rand(-S.shake, S.shake) * 0.5);
    // 摄像机：世界坐标 → 屏幕坐标。走动时"地图在动"，视野是有限的
    ctx.translate(-(S.cam.x - W / 2), -(S.cam.y - H / 2));
    drawBackground();
    if (S.state !== 'title') {
      drawObstacles();
      // 子弹（视口外的跳过绘制）
      for (let i = 0; i < S.bullets.length; i++) {
        const b = S.bullets[i];
        if (!inView(b.x, b.y, 40)) continue;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fillStyle = '#bfe0ff';
        ctx.fill();
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        ctx.arc(b.x - b.vx * 0.006, b.y - b.vy * 0.006, b.r * 0.9, 0, Math.PI * 2);
        ctx.fillStyle = '#5aa8ff';
        ctx.fill();
        ctx.restore();
      }
      drawPacks();
      for (let i = 0; i < S.enemies.length; i++) drawEnemy(S.enemies[i]);
      for (let i = 0; i < S.parts.length; i++) {
        const p = S.parts[i];
        if (!inView(p.x, p.y, 40)) continue;
        ctx.save();
        ctx.globalAlpha = 1 - p.t / p.life;
        ctx.fillStyle = '#fff';
        ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
        ctx.restore();
      }
      for (let i = 0; i < S.rings.length; i++) {
        const r = S.rings[i];
        ctx.save();
        ctx.globalAlpha = 1 - r.t / r.max;
        ctx.strokeStyle = r.color || '#ffd166';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(r.x, r.y, r.r + (r.t / r.max) * 260, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      if (S.state !== 'dead' && S.state !== 'win') { drawPlayer(); drawFloats(); }
    }
    ctx.restore();

    // ---- 以下全部是屏幕坐标：暗角 + HUD + 各种界面 ----
    const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.42, W / 2, H / 2, H * 0.95);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,.42)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
    if (S.state !== 'title') drawHud();
    if (MOBILE && !S.settings) drawTouchUi();
    if (S.state === 'title') drawTitle();
    else if (S.state === 'upgrade') drawUpgrade();
    else if (S.state === 'dead') drawEnd(false);
    else if (S.state === 'win') drawEnd(true);
    else if (S.state === 'paused') {
      ctx.save();
      ctx.fillStyle = 'rgba(4,7,12,.7)';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      ctx.textAlign = 'center';
      ctx.font = '800 40px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText('已暂停', W / 2, H / 2);
      ctx.font = '500 16px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillStyle = '#8fa6c6';
      ctx.fillText(MOBILE ? '点屏幕继续' : '按 Esc 继续', W / 2, H / 2 + 34);
    }
    if (S.settings) drawSettings();      // 设置面板画在最上面
    requestAnimationFrame(frame);
  }

  // ==================== 输入 ====================
  function toLogical(ev) {
    const r = cv.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / Math.max(1, r.width) * W,
             y: (ev.clientY - r.top) / Math.max(1, r.height) * H };
  }
  const isTouchPointer = function (e) {
    return e.pointerType === 'touch' || e.pointerType === 'pen';
  };

  // 一根手指落下：先判设置面板 → 齿轮 → 界面态 → 顶栏按钮 → 摇杆区 / 瞄准区
  function onPointerDown(e) {
    const p = toLogical(e);
    const finger = isTouchPointer(e);
    if (!finger) { mouse.x = p.x; mouse.y = p.y; aimPoint.x = p.x; aimPoint.y = p.y; }

    // ---- 设置面板：打开时吃掉所有输入，点面板外就关掉 ----
    if (S.settings) {
      const L = settingsLayout();
      if (inBox(p, L.mobile)) { setMobileMode(!MOBILE); return; }
      if (inBox(p, L.sound)) { S.muted = !S.muted; return; }
      if (inBox(p, L.close)) { S.settings = false; return; }
      S.settings = false;                 // 点面板外面也当关闭（不误开火）
      return;
    }
    // ---- 左上角齿轮：进设置（标题界面也能开）----
    if (S.state !== 'upgrade' && inBox(p, GEAR_HIT)) {
      S.settings = true;
      touchReset();
      return;
    }

    // 任何"界面态"下先吃掉触摸，别让它变成开火
    if (S.state === 'title') { reset(); return; }
    if (S.state === 'dead' || S.state === 'win') { reset(); return; }
    if (S.state === 'upgrade') {
      for (let i = 0; i < S.choices.length; i++) {
        const R = S.choices[i]._rect;
        if (R && hitRect(p.x, p.y, R.x, R.y, R.w, R.h)) { chooseUpgrade(i); return; }
      }
      return;
    }
    if (MOBILE) {
      const b = hitTouchButton(p);
      if (b) { b.fn(); return; }
    }
    if (S.state === 'paused') { S.state = S.pauseReturn || 'playing'; return; }

    if (finger) {
      // 左下角：虚拟摇杆（原点就是按下的地方）—— 只在手机模式下生效
      if (MOBILE && p.x < W * STICK.zoneX && p.y > H * STICK.zoneY && touch.moveId === null) {
        touch.moveId = e.pointerId === undefined ? 1 : e.pointerId;
        touch.ox = touch.mx = p.x;
        touch.oy = touch.my = p.y;
        return;
      }
      // 其他地方：点哪打哪
      if (touch.aimId === null) {
        touch.aimId = e.pointerId === undefined ? 2 : e.pointerId;
        touch.ax = p.x; touch.ay = p.y;
        aimPoint.x = p.x; aimPoint.y = p.y;
      }
      return;
    }
    mouse.down = true;
  }

  function onPointerMove(e) {
    const p = toLogical(e);
    if (isTouchPointer(e)) {
      if (touch.moveId !== null && touch.moveId === e.pointerId) {
        touch.mx = p.x; touch.my = p.y;
      } else if (touch.aimId !== null && touch.aimId === e.pointerId) {
        touch.ax = p.x; touch.ay = p.y;
        aimPoint.x = p.x; aimPoint.y = p.y;
      }
      return;
    }
    mouse.x = p.x; mouse.y = p.y;
    aimPoint.x = p.x; aimPoint.y = p.y;
  }

  function onPointerUp(e) {
    if (isTouchPointer(e)) {
      if (touch.moveId === e.pointerId) touch.moveId = null;
      else if (touch.aimId === e.pointerId) touch.aimId = null;
      return;
    }
    mouse.down = false;
  }

  window.addEventListener('keydown', function (e) {
    const k = e.key.toLowerCase();
    keys[k] = true;
    if (k === 'escape') {
      if (S.settings) { S.settings = false; }
      else if (S.state === 'playing' || S.state === 'break') { S.pauseReturn = S.state; S.state = 'paused'; }
      else if (S.state === 'paused') S.state = S.pauseReturn || 'playing';
    }
    if (k === 'm') S.muted = !S.muted;
    if (k === 'r' && (S.state === 'dead' || S.state === 'win' || S.state === 'title')) reset();
    if ((k === ' ' || k === 'enter') && S.state === 'title') reset();
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].indexOf(k) >= 0) {
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', function (e) { keys[e.key.toLowerCase()] = false; });
  cv.addEventListener('pointermove', function (e) { onPointerMove(e); });
  cv.addEventListener('pointerdown', function (e) { onPointerDown(e); });
  window.addEventListener('pointermove', function (e) { onPointerMove(e); });
  window.addEventListener('pointerup', function (e) { onPointerUp(e); });
  window.addEventListener('pointercancel', function (e) { onPointerUp(e); });
  window.addEventListener('blur', function () { mouse.down = false; touchReset(); });
  window.addEventListener('contextmenu', function (e) {
    // 手机上长按别弹右键菜单/放大镜
    if (MOBILE) e.preventDefault();
  });
  cv.addEventListener('dblclick', function (e) { e.preventDefault(); });
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () { setTimeout(resize, 120); });

  // ==================== 调试 / 自动化钩子 ====================
  window.__GAME = {
    get S() { return S; },
    get P() { return P; },
    reset: reset,
    start: reset,
    win: function () { S.state = 'win'; },
    die: function () { S.state = 'dead'; P.hp = 0; },
    xp: function (n) { gainXp(n); },
    wave: function (n) { startWave(n); },
    boss: function () { spawnEnemy('boss'); },
    enemy: function (t) { spawnEnemy(t || 'grunt'); },
    hits: function () { return { bullets: S.bullets.length, enemies: S.enemies.length }; },
    upgrade: function (i) { chooseUpgrade(i); },
    pack: function (k) { spawnPack(k); },
    packs: function () { return S.packs.length; },
    shieldMax: shieldMax,
    get mobile() { return MOBILE; },
    setMobile: setMobileMode,
    get settings() { return S.settings; },
  };

  resize();
  requestAnimationFrame(frame);
})();

