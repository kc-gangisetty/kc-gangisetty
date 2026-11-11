/* Snowflake course app: hash routing, rendering, quiz + practice state. */
(function () {
  "use strict";

  var COURSE = window.COURSE || [];
  var TRACKS = [
    "Foundations",
    "Building in Snowflake",
    "Pipelines and CDC",
    "Performance and Operations",
    "Security and Governance",
    "Staff Engineer"
  ];
  var STORE_KEY = "sfcourse.v1";

  /* ---------- progress store (per browser, best effort) ---------- */
  var state = { read: {}, quiz: {}, solved: {} };
  try {
    var raw = window.localStorage.getItem(STORE_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      state.read = parsed.read || {};
      state.quiz = parsed.quiz || {};
      state.solved = parsed.solved || {};
    }
  } catch (e) { /* storage blocked: progress just won't persist */ }
  function save() {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var KEYWORDS = ("select from where and or not in is null as on join inner left right full outer cross natural using group by order having " +
    "limit offset qualify over partition rows range between unbounded preceding following current row with recursive union all " +
    "intersect except minus distinct case when then else end create replace or alter drop undrop table view schema database warehouse " +
    "materialized secure dynamic transient temporary temp if exists insert into values update set delete merge matched truncate copy " +
    "stage pipe stream task file format grant revoke role user to usage ownership future privileges show describe desc use clone at before " +
    "offset timestamp statement cluster sequence function procedure returns return language sql javascript python handler runtime_version " +
    "packages begin declare let for loop while do call execute immediate commit rollback transaction policy masking row access tag " +
    "resource monitor share account integration network rule target_lag refresh_mode initialize lateral flatten pivot unpivot sample " +
    "tablesample asc desc nulls first last true false default comment after schedule allow_overlapping_execution suspend resume " +
    "unset add modify column columns primary key foreign references unique constraint identity autoincrement check view_name " +
    "auto_ingest notification alert exception raise cursor result_scan explain called input strict immutable volatile memoizable " +
    "managed access database_role session secondary changes information append_only show_initial_rows only interval day days hour minute " +
    "minutes second seconds month year week like ilike rlike regexp any some exists cast try_cast").split(/\s+/);
  var KW = {};
  KEYWORDS.forEach(function (k) { if (k) KW[k] = true; });

  function highlight(src) {
    var out = "";
    var re = /(--[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^'\\]|\\.|'')*')|(\$\$[\s\S]*?\$\$)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_$]*)(\s*\()?|([\s\S])/g;
    var m;
    while ((m = re.exec(src)) !== null) {
      if (m[1]) out += '<span class="tok-com">' + esc(m[1]) + "</span>";
      else if (m[2]) out += '<span class="tok-str">' + esc(m[2]) + "</span>";
      else if (m[3]) out += '<span class="tok-str">' + esc(m[3]) + "</span>";
      else if (m[4]) out += '<span class="tok-num">' + esc(m[4]) + "</span>";
      else if (m[5]) {
        var w = m[5];
        if (m[6] && !KW[w.toLowerCase()]) out += '<span class="tok-fn">' + esc(w) + "</span>" + esc(m[6]);
        else if (KW[w.toLowerCase()]) out += '<span class="tok-kw">' + esc(w) + "</span>" + (m[6] ? esc(m[6]) : "");
        else out += esc(w) + (m[6] ? esc(m[6]) : "");
      } else out += esc(m[7]);
    }
    return out;
  }

  function dedent(s) {
    s = String(s).replace(/^\n+/, "").replace(/\s+$/, "");
    var lines = s.split("\n");
    var min = Infinity;
    lines.forEach(function (l) {
      if (l.trim()) { var n = l.match(/^ */)[0].length; if (n < min) min = n; }
    });
    if (!isFinite(min)) min = 0;
    return lines.map(function (l) { return l.slice(min); }).join("\n");
  }

  var codeStore = [];
  function codeBlock(src) {
    var clean = dedent(src);
    var id = codeStore.push(clean) - 1;
    return '<div class="code"><button class="copy" type="button" data-code="' + id + '">Copy</button><pre><code>' +
      highlight(clean) + "</code></pre></div>";
  }

  /* Content bodies are HTML with <sql>...</sql> blocks holding raw SQL. */
  function rich(html) {
    if (!html) return "";
    return String(html)
      .replace(/<sql>([\s\S]*?)<\/sql>/g, function (_, code) { return codeBlock(code); })
      .replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>");
  }

  /* ---------- progress maths ---------- */
  function modStats(mod) {
    var qAns = state.quiz[mod.id] || {};
    var qDone = Object.keys(qAns).length;
    var qRight = 0;
    Object.keys(qAns).forEach(function (k) { if (mod.quiz[k] && qAns[k] === mod.quiz[k].answer) qRight++; });
    var sol = state.solved[mod.id] || {};
    var pDone = Object.keys(sol).filter(function (k) { return sol[k]; }).length;
    var read = !!state.read[mod.id];
    var total = 1 + mod.quiz.length + mod.practice.length;
    var done = (read ? 1 : 0) + qDone + pDone;
    var status = done === 0 ? "" : (read && qDone === mod.quiz.length && pDone === mod.practice.length ? "done" : "part");
    return { qDone: qDone, qRight: qRight, pDone: pDone, read: read, total: total, done: done, status: status };
  }
  function overall() {
    var t = 0, d = 0;
    COURSE.forEach(function (m) { var s = modStats(m); t += s.total; d += s.done; });
    return t ? Math.round((d / t) * 100) : 0;
  }

  /* ---------- rail ---------- */
  function renderRail(activeId) {
    var html = "";
    TRACKS.forEach(function (track) {
      var mods = COURSE.filter(function (m) { return m.track === track; });
      if (!mods.length) return;
      html += '<div class="track-group"><div class="track-label">' + esc(track) + "</div>";
      mods.forEach(function (m) {
        var s = modStats(m);
        html += '<a class="nav-item' + (m.id === activeId ? " active" : "") + '" href="#m-' + m.id + '">' +
          '<span class="nav-num">' + esc(m.num) + "</span><span>" + esc(m.title) + '</span><span class="nav-dot ' + s.status + '" title="' +
          (s.status === "done" ? "Complete" : s.status === "part" ? "In progress" : "Not started") + '"></span></a>';
      });
      html += "</div>";
    });
    $("#nav").innerHTML = html;
    var pct = overall();
    $("#overall-pct").textContent = pct + "% complete";
    $("#overall-bar").style.width = pct + "%";
  }

  /* ---------- home ---------- */
  var SCHEMA = {
    tables: [
      { n: "NATION", x: 20, y: 40, rows: "25", cols: ["N_NATIONKEY", "N_NAME", "N_REGIONKEY", "N_COMMENT"] },
      { n: "REGION", x: 20, y: 250, rows: "5", cols: ["R_REGIONKEY", "R_NAME", "R_COMMENT"] },
      { n: "CUSTOMER", x: 270, y: 20, rows: "150,000", cols: ["C_CUSTKEY", "C_NAME", "C_NATIONKEY", "C_ACCTBAL", "C_MKTSEGMENT", "C_PHONE"] },
      { n: "SUPPLIER", x: 270, y: 260, rows: "10,000", cols: ["S_SUPPKEY", "S_NAME", "S_NATIONKEY", "S_ACCTBAL"] },
      { n: "ORDERS", x: 520, y: 20, rows: "1,500,000", cols: ["O_ORDERKEY", "O_CUSTKEY", "O_ORDERSTATUS", "O_TOTALPRICE", "O_ORDERDATE", "O_ORDERPRIORITY"] },
      { n: "PARTSUPP", x: 520, y: 260, rows: "800,000", cols: ["PS_PARTKEY", "PS_SUPPKEY", "PS_AVAILQTY", "PS_SUPPLYCOST"] },
      { n: "LINEITEM", x: 770, y: 20, rows: "6,001,215", cols: ["L_ORDERKEY", "L_PARTKEY", "L_SUPPKEY", "L_LINENUMBER", "L_QUANTITY", "L_EXTENDEDPRICE", "L_DISCOUNT", "L_SHIPDATE", "L_RETURNFLAG"] },
      { n: "PART", x: 770, y: 290, rows: "200,000", cols: ["P_PARTKEY", "P_NAME", "P_BRAND", "P_TYPE", "P_RETAILPRICE"] }
    ],
    rels: [
      ["NATION", "N_REGIONKEY", "REGION", "R_REGIONKEY"],
      ["CUSTOMER", "C_NATIONKEY", "NATION", "N_NATIONKEY"],
      ["SUPPLIER", "S_NATIONKEY", "NATION", "N_NATIONKEY"],
      ["ORDERS", "O_CUSTKEY", "CUSTOMER", "C_CUSTKEY"],
      ["LINEITEM", "L_ORDERKEY", "ORDERS", "O_ORDERKEY"],
      ["LINEITEM", "L_PARTKEY", "PARTSUPP", "PS_PARTKEY"],
      ["PARTSUPP", "PS_SUPPKEY", "SUPPLIER", "S_SUPPKEY"],
      ["PARTSUPP", "PS_PARTKEY", "PART", "P_PARTKEY"]
    ]
  };
  function schemaSvg() {
    var W = 190, H = 24, R = 17;
    var byName = {};
    SCHEMA.tables.forEach(function (t) { byName[t.n] = t; });
    function colY(t, c) { return t.y + H + R * t.cols.indexOf(c) + R / 2 + 2; }
    var paths = "";
    SCHEMA.rels.forEach(function (r, i) {
      var a = byName[r[0]], b = byName[r[2]];
      var y1 = colY(a, r[1]), y2 = colY(b, r[3]);
      var d;
      if (a.x === b.x) {
        d = "M" + a.x + " " + y1 + " h-12 V" + y2 + " h12";
      } else {
        var x1 = a.x < b.x ? a.x + W : a.x;
        var x2 = a.x < b.x ? b.x : b.x + W;
        var mid = (x1 + x2) / 2 + ((i % 3) - 1) * 8;
        d = "M" + x1 + " " + y1 + " H" + mid + " V" + y2 + " H" + x2;
      }
      paths += '<path class="rel" d="' + d + '"/><circle cx="' + (a.x === b.x ? b.x : (a.x < b.x ? b.x : b.x + W)) + '" cy="' + y2 + '" r="3" fill="currentColor" style="color:var(--ink-soft)"/>';
    });
    var boxes = "";
    SCHEMA.tables.forEach(function (t) {
      var h = H + R * t.cols.length + 6;
      boxes += '<g class="tbl"><rect class="body" x="' + t.x + '" y="' + t.y + '" width="' + W + '" height="' + h + '" rx="6"/>' +
        '<rect class="head" x="' + t.x + '" y="' + t.y + '" width="' + W + '" height="' + H + '" rx="6"/>' +
        '<rect class="head" x="' + t.x + '" y="' + (t.y + H - 6) + '" width="' + W + '" height="6"/>' +
        '<text class="h" x="' + (t.x + 10) + '" y="' + (t.y + 16) + '">' + t.n + "</text>";
      t.cols.forEach(function (c, i) {
        boxes += '<text class="' + (i === 0 ? "k" : "c") + '" x="' + (t.x + 10) + '" y="' + (t.y + H + R * i + 14) + '">' + c + "</text>";
      });
      boxes += '<text class="rows" x="' + (t.x + W - 8) + '" y="' + (t.y + h + 13) + '" text-anchor="end">' + t.rows + " rows</text></g>";
    });
    return '<div class="schema-wrap"><svg viewBox="0 0 980 420" role="img" aria-label="TPC-H schema in SNOWFLAKE_SAMPLE_DATA.TPCH_SF1 with eight tables and their key relationships">' +
      paths + boxes + "</svg></div>";
  }

  function renderHome() {
    var nQ = 0, nP = 0, nL = 0;
    COURSE.forEach(function (m) { nQ += m.quiz.length; nP += m.practice.length; nL += m.lessons.length; });
    var first = COURSE[0];
    var html = '<div class="page">' +
      '<section class="hero"><span class="eyebrow">Built on SNOWFLAKE_SAMPLE_DATA</span>' +
      "<h1>Snowflake, from first query to staff engineer</h1>" +
      '<p class="lede">A hands-on course that uses the TPC-H sample data every Snowflake account ships with. Read a lesson, run the SQL in a worksheet, take the quiz, then work through practice problems that start easy and end with the kind of questions you get in a staff-level design review.</p>' +
      '<div class="stats"><span><b>' + COURSE.length + "</b>modules</span><span><b>" + nL + "</b>lessons</span><span><b>" + nQ + "</b>quiz questions</span><span><b>" + nP + "</b>practice problems</span><span><b>" + overall() + "%</b>your progress</span></div>" +
      '<div class="cta-row"><a class="btn" href="#m-' + first.id + '">Start with module 01</a><a class="btn ghost" href="#m-' + resumeId() + '">Resume where I left off</a></div></section>' +
      '<section class="prose"><h2 class="section-title">The data you will use</h2>' +
      "<p>Almost every example runs against <code>SNOWFLAKE_SAMPLE_DATA.TPCH_SF1</code>, a small TPC-H dataset of customers, orders and the parts and suppliers behind them. It is read-only and shared with your account, so module 01 shows you how to copy it into your own database whenever you need to change data. Bigger scale factors (<code>TPCH_SF10</code>, <code>TPCH_SF100</code>, <code>TPCH_SF1000</code>) and the TPC-DS schemas come in when we need volume for performance work.</p>" +
      schemaSvg() +
      '<p class="muted">Key columns are highlighted. Lines run from foreign key to primary key. Row counts are for scale factor 1.</p></section>' +
      '<section class="track-map"><h2 class="section-title">Course map</h2>';
    TRACKS.forEach(function (track) {
      var mods = COURSE.filter(function (m) { return m.track === track; });
      if (!mods.length) return;
      html += '<div class="track-row"><h3>' + esc(track) + '</h3><div class="mod-grid">';
      mods.forEach(function (m) {
        var s = modStats(m);
        html += '<a class="mod-card" href="#m-' + m.id + '"><span class="num">Module ' + esc(m.num) + "</span><h4>" + esc(m.title) + "</h4><p>" + esc(m.summary) +
          '</p><span class="meta"><span>' + m.lessons.length + " lessons</span><span>" + m.quiz.length + " quiz</span><span>" + m.practice.length + " practice</span><span>" +
          (s.status === "done" ? "Complete" : s.status === "part" ? Math.round((s.done / s.total) * 100) + "% done" : "") + "</span></span></a>";
      });
      html += "</div></div>";
    });
    html += "</section>" +
      '<section class="mark-row"><p>Progress is saved in this browser only. Clearing it resets every quiz answer and solved problem.</p><button class="btn quiet small" type="button" id="reset-all">Reset all progress</button></section>' +
      "</div>";
    $("#main").innerHTML = html;
    var reset = $("#reset-all");
    reset.addEventListener("click", function () {
      if (reset.dataset.armed) {
        state = { read: {}, quiz: {}, solved: {} }; save(); route();
      } else {
        reset.dataset.armed = "1"; reset.textContent = "Click again to confirm";
      }
    });
  }
  function resumeId() {
    for (var i = 0; i < COURSE.length; i++) { if (modStats(COURSE[i]).status !== "done") return COURSE[i].id; }
    return COURSE[COURSE.length - 1].id;
  }

  /* ---------- module ---------- */
  var practiceFilter = "All";
  function renderModule(mod, tab) {
    codeStore = [];
    var idx = COURSE.indexOf(mod);
    var s = modStats(mod);
    var html = '<div class="page"><header class="mod-head"><span class="eyebrow">Module ' + esc(mod.num) + " · " + esc(mod.track) + "</span><h1>" + esc(mod.title) +
      '</h1><p class="lede">' + esc(mod.summary) + '</p><div class="chips"><span class="chip">' + esc(mod.minutes) + " min</span><span class=\"chip\">" + esc(mod.level) + "</span>" +
      (mod.edition ? '<span class="chip">' + esc(mod.edition) + "</span>" : "") + "</div></header>" +
      '<div class="tabs" role="tablist">' +
      tabBtn(mod, "learn", "Learn", mod.lessons.length, tab) +
      tabBtn(mod, "quiz", "Quiz", s.qDone + "/" + mod.quiz.length, tab) +
      tabBtn(mod, "practice", "Practice", s.pDone + "/" + mod.practice.length, tab) +
      '</div><div id="tab-body" role="tabpanel"></div>';
    var prev = COURSE[idx - 1], next = COURSE[idx + 1];
    html += '<nav class="footer-nav">' + (prev ? '<a class="btn quiet small" href="#m-' + prev.id + '">← ' + esc(prev.num + " " + prev.title) + "</a>" : '<a class="btn quiet small" href="#home">← Course home</a>') +
      (next ? '<a class="btn quiet small" href="#m-' + next.id + '">' + esc(next.num + " " + next.title) + " →</a>" : "") + "</nav></div>";
    $("#main").innerHTML = html;
    var body = $("#tab-body");
    if (tab === "quiz") renderQuiz(mod, body);
    else if (tab === "practice") renderPractice(mod, body);
    else renderLearn(mod, body);
  }
  function tabBtn(mod, key, label, count, tab) {
    return '<a class="tab" role="tab" aria-selected="' + (tab === key) + '" href="#m-' + mod.id + (key === "learn" ? "" : "-" + key) + '">' + label + ' <span class="count">' + count + "</span></a>";
  }

  function renderLearn(mod, body) {
    var html = '<div class="page" style="gap:26px"><nav class="toc"><b>In this module</b>';
    mod.lessons.forEach(function (l, i) { html += '<a href="#m-' + mod.id + '" data-jump="lesson-' + i + '">' + (i + 1) + ". " + esc(l.title) + "</a>"; });
    html += "</nav>";
    mod.lessons.forEach(function (l, i) {
      html += '<article class="lesson" id="lesson-' + i + '"><h2>' + (i + 1) + ". " + esc(l.title) + '</h2><div class="prose">' + rich(l.body) + "</div></article>";
    });
    var read = !!state.read[mod.id];
    html += '<div class="mark-row"><p>' + (read ? "You marked these lessons as read. Next up: the quiz." : "Finished reading? Mark it, then check yourself with the quiz.") +
      '</p><button class="btn small' + (read ? " quiet" : "") + '" type="button" id="mark-read">' + (read ? "Mark as unread" : "Mark lessons as read") + "</button>" +
      '<a class="btn ghost small" href="#m-' + mod.id + '-quiz">Go to quiz</a></div></div>';
    body.innerHTML = html;
    $all("[data-jump]", body).forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        var t = document.getElementById(a.getAttribute("data-jump"));
        if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    $("#mark-read").addEventListener("click", function () {
      if (state.read[mod.id]) delete state.read[mod.id]; else state.read[mod.id] = true;
      save(); renderModule(mod, "learn"); renderRail(mod.id);
    });
  }

  /* Stable per-question shuffle so the correct option isn't always in the same slot. */
  function optionOrder(modId, qi, n) {
    var seed = 2166136261;
    var key = modId + ":" + qi;
    for (var i = 0; i < key.length; i++) { seed ^= key.charCodeAt(i); seed = Math.imul(seed, 16777619) >>> 0; }
    var order = [];
    for (var k = 0; k < n; k++) order.push(k);
    for (var j = n - 1; j > 0; j--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      var r = seed % (j + 1);
      var t = order[j]; order[j] = order[r]; order[r] = t;
    }
    return order;
  }

  function renderQuiz(mod, body) {
    var ans = state.quiz[mod.id] || {};
    var s = modStats(mod);
    var html = '<div class="page" style="gap:16px"><div class="quiz-head"><span class="score">Score: ' + s.qRight + " / " + mod.quiz.length +
      (s.qDone < mod.quiz.length ? ' <span class="muted" style="font-size:0.85rem">(' + (mod.quiz.length - s.qDone) + " unanswered)</span>" : "") +
      '</span><button class="btn quiet small" type="button" id="quiz-reset">Retake quiz</button></div><div class="q-list">';
    mod.quiz.forEach(function (q, qi) {
      var chosen = ans[qi];
      var answered = chosen !== undefined;
      html += '<div class="q-card"><span class="q-num">Question ' + (qi + 1) + '</span><div class="q-text prose">' + rich(q.q) + '</div><div class="opts">';
      var order = optionOrder(mod.id, qi, q.options.length);
      order.forEach(function (oi, pos) {
        var o = q.options[oi];
        var cls = "";
        if (answered && oi === q.answer) cls = " correct";
        else if (answered && oi === chosen) cls = " wrong";
        html += '<button type="button" class="opt' + cls + '" data-q="' + qi + '" data-o="' + oi + '"' + (answered ? " disabled" : "") + '><span class="letter">' +
          String.fromCharCode(65 + pos) + "</span><span>" + o + "</span></button>";
      });
      html += "</div>";
      if (answered) {
        var ok = chosen === q.answer;
        html += '<div class="why"><span class="verdict ' + (ok ? "ok" : "no") + '">' + (ok ? "Correct." : "Not quite. The answer is " + String.fromCharCode(65 + order.indexOf(q.answer)) + ".") +
          '</span><div class="prose">' + rich(q.why) + "</div></div>";
      }
      html += "</div>";
    });
    html += "</div></div>";
    body.innerHTML = html;
    $all(".opt", body).forEach(function (b) {
      b.addEventListener("click", function () {
        var qi = +b.dataset.q, oi = +b.dataset.o;
        state.quiz[mod.id] = state.quiz[mod.id] || {};
        state.quiz[mod.id][qi] = oi;
        save();
        var y = window.scrollY;
        renderModule(mod, "quiz"); renderRail(mod.id);
        window.scrollTo(0, y);
      });
    });
    $("#quiz-reset").addEventListener("click", function () {
      delete state.quiz[mod.id]; save(); renderModule(mod, "quiz"); renderRail(mod.id);
    });
  }

  function renderPractice(mod, body) {
    var levels = ["All", "Easy", "Medium", "Hard"];
    var html = '<div class="page" style="gap:16px"><div class="filter-row"><span class="lbl">Difficulty</span>';
    levels.forEach(function (l) { html += '<button type="button" class="pill" data-level="' + l + '" aria-pressed="' + (practiceFilter === l) + '">' + l + "</button>"; });
    html += "</div>";
    var sol = state.solved[mod.id] || {};
    mod.practice.forEach(function (p, pi) {
      if (practiceFilter !== "All" && p.level !== practiceFilter) return;
      var solved = !!sol[pi];
      html += '<div class="p-card' + (solved ? " solved" : "") + '" id="p-' + pi + '"><div class="p-top"><span class="chip ' + p.level.toLowerCase() + '">' + p.level + "</span><h3>" + (pi + 1) + ". " + esc(p.title) +
        '</h3></div><div class="prose">' + rich(p.prompt) + "</div>" +
        '<div class="p-actions">' + (p.hint ? '<button type="button" class="btn quiet small" data-hint="' + pi + '">Show hint</button>' : "") +
        '<button type="button" class="btn small" data-reveal="' + pi + '">Reveal answer</button>' +
        '<label class="solved-toggle"><input type="checkbox" id="solved-' + mod.id + "-" + pi + '" data-solved="' + pi + '"' + (solved ? " checked" : "") + "> I solved this</label></div>" +
        (p.hint ? '<div class="hint" id="hint-' + pi + '" hidden><b>Hint:</b> ' + p.hint + "</div>" : "") +
        '<div class="answer" id="ans-' + pi + '" hidden><h4>Answer</h4>' + codeBlock(p.answer) + "<h4>Why and how it works</h4><div class=\"prose\">" + rich(p.why) + "</div></div></div>";
    });
    html += "</div>";
    body.innerHTML = html;
    $all("[data-level]", body).forEach(function (b) {
      b.addEventListener("click", function () { practiceFilter = b.dataset.level; renderPractice(mod, body); });
    });
    $all("[data-hint]", body).forEach(function (b) {
      b.addEventListener("click", function () {
        var h = document.getElementById("hint-" + b.dataset.hint); h.hidden = !h.hidden;
        b.textContent = h.hidden ? "Show hint" : "Hide hint";
      });
    });
    $all("[data-reveal]", body).forEach(function (b) {
      b.addEventListener("click", function () {
        var a = document.getElementById("ans-" + b.dataset.reveal); a.hidden = !a.hidden;
        b.textContent = a.hidden ? "Reveal answer" : "Hide answer";
      });
    });
    $all("[data-solved]", body).forEach(function (c) {
      c.addEventListener("change", function () {
        state.solved[mod.id] = state.solved[mod.id] || {};
        if (c.checked) state.solved[mod.id][c.dataset.solved] = true; else delete state.solved[mod.id][c.dataset.solved];
        save();
        c.closest(".p-card").classList.toggle("solved", c.checked);
        renderRail(mod.id);
        var tabs = $all(".tab .count");
        if (tabs[2]) tabs[2].textContent = modStats(mod).pDone + "/" + mod.practice.length;
      });
    });
  }

  /* ---------- copy buttons (delegated) ---------- */
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest(".copy");
    if (!b) return;
    var text = codeStore[+b.dataset.code];
    function done(msg) { b.textContent = msg; setTimeout(function () { b.textContent = "Copy"; }, 1400); }
    function fallback() {
      var pre = b.parentNode.querySelector("pre");
      var range = document.createRange(); range.selectNodeContents(pre);
      var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      done("Selected");
    }
    try {
      navigator.clipboard.writeText(text).then(function () { done("Copied"); }, fallback);
    } catch (err) { fallback(); }
  });

  /* ---------- routing ---------- */
  function route() {
    var h = (location.hash || "").replace(/^#/, "");
    closeRail();
    var m = h.match(/^m-([a-z0-9-]+?)(?:-(quiz|practice))?$/);
    if (m) {
      var mod = COURSE.filter(function (x) { return x.id === m[1]; })[0];
      if (mod) {
        renderModule(mod, m[2] || "learn");
        renderRail(mod.id);
        window.scrollTo(0, 0);
        return;
      }
    }
    renderHome();
    renderRail(null);
    window.scrollTo(0, 0);
  }

  function openRail() { $("#rail").classList.add("open"); $("#scrim").classList.add("open"); }
  function closeRail() { $("#rail").classList.remove("open"); $("#scrim").classList.remove("open"); }
  $("#menu-btn").addEventListener("click", openRail);
  $("#scrim").addEventListener("click", closeRail);
  window.addEventListener("hashchange", route);
  route();
})();
