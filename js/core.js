/* Ядро: разбор выгрузки «первой формы», область отслеживания, сравнение двух выгрузок.
   Чистые функции без DOM — их же гоняет tests.html. */
(function (root) {
  'use strict';

  // Порядок этапов в воронке (слева направо). Если в выгрузке появится новый этап,
  // его нужно добавить сюда в правильное место.
  const STAGES = [
    'В работе',
    'Согласование',
    'Оценка',
    'Подготовительные работы',
    'Строительные работы',
    'Подготовка исполнительной документации',
  ];
  const STAGE_RANK = {};
  STAGES.forEach((s, i) => (STAGE_RANK[s] = i));

  const DEFAULT_SCOPE = {
    regions: ['Москва', 'МО', 'СПб', 'ЛО'],
    brands: ['ВкусВилл', 'Грейстор'],
    tt: ['Новая ТТ'],
    stages: ['Оценка', 'Подготовительные работы', 'Строительные работы'],
  };

  // Заголовок в Excel → ключ в данных
  const COLS = {
    'Номер задачи': 'id',
    'Регион': 'region',
    'Адрес': 'address',
    'Номер торговой точки': 'shop',
    'Сотрудник отдела поиска': 'searcher',
    'Менеджер по развитию': 'devManager',
    'Статус ТТ': 'tt',
    'Бренд': 'brand',
    'Дата создания': 'created',
    'Статус': 'stage',
    'Заказчик': 'customer',
    'Исполнитель': 'executor',
    'Второе подтверждение': 'confirm2',
    'Территория': 'territory',
    'Проектный менеджер': 'pm',
    'Юрисконсульт': 'lawyer',
    'Руководитель строительного отдела': 'builder',
    'Срок': 'due',
    'Фактическая дата открытия (первая тыс.)': 'openedAt', // появилась со 2-й выгрузки, необязательная
  };
  const REQUIRED = ['Номер задачи', 'Адрес', 'Регион', 'Сотрудник отдела поиска', 'Статус', 'Статус ТТ', 'Бренд'];
  const DATE_KEYS = ['created', 'due', 'openedAt'];

  const NO_PERSON = '— не указан —';

  /* ---------- регионы ---------- */
  function normRegion(r) {
    if (!r) return 'Не указан';
    const s = String(r).toLowerCase().replace(/\s+/g, ' ').trim();
    if (/ленинград/.test(s)) return 'ЛО';
    if (/петербург/.test(s)) return 'СПб'; // «г Санкт-Петербург», «Санкт- Петербург»
    if (/московск|^мо$|балаших/.test(s)) return 'МО';
    if (/москва/.test(s)) return 'Москва';
    return 'Другие';
  }

  /* ---------- даты ---------- */
  function pad(n) { return String(n).padStart(2, '0'); }

  // Excel-серийное число → 'YYYY-MM-DD' (время суток отбрасываем, часовых поясов нет)
  function serialToISO(n) {
    const ms = Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }

  function toISO(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) {
      return v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate());
    }
    if (typeof v === 'number') return isFinite(v) ? serialToISO(v) : null;
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (m) return m[3] + '-' + pad(m[2]) + '-' + pad(m[1]);
    return null;
  }

  function daysBetween(a, b) { // b - a в днях, строки ISO
    return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  }

  const MONTHS = { 'января': 1, 'февраля': 2, 'марта': 3, 'апреля': 4, 'мая': 5, 'июня': 6, 'июля': 7, 'августа': 8, 'сентября': 9, 'октября': 10, 'ноября': 11, 'декабря': 12 };

  // Дата выгрузки из имени файла: «..._3_ноября.xlsx», «2026-11-10», «10.11.2026». Иначе null.
  function guessDateFromName(name, fallbackYear) {
    const n = String(name || '');
    let m = n.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[0];
    m = n.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (m) return m[3] + '-' + pad(m[2]) + '-' + pad(m[1]);
    m = n.toLowerCase().match(/(\d{1,2})[\s_.\-]*(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/);
    if (m && fallbackYear) return fallbackYear + '-' + pad(MONTHS[m[2]]) + '-' + pad(m[1]);
    return null;
  }

  /* ---------- разбор таблицы ---------- */
  function cleanStr(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).replace(/\s+/g, ' ').trim();
    return s === '' ? null : s;
  }

  // aoa — массив строк листа (как отдаёт XLSX.utils.sheet_to_json(ws,{header:1,raw:true,defval:null}))
  function parseAoa(aoa) {
    let h = -1;
    for (let i = 0; i < Math.min(aoa.length, 15); i++) {
      if (aoa[i] && aoa[i].some((c) => cleanStr(c) === 'Номер задачи')) { h = i; break; }
    }
    if (h < 0) return { error: 'Не нашёл строку заголовков (колонка «Номер задачи»). Это точно выгрузка из первой формы?' };

    const head = aoa[h].map(cleanStr);
    const idx = {};
    head.forEach((t, i) => { if (t && COLS[t] && idx[t] === undefined) idx[t] = i; });
    const missing = REQUIRED.filter((c) => idx[c] === undefined);
    if (missing.length) return { error: 'В файле нет обязательных колонок: ' + missing.join(', ') };

    const rows = [];
    let skipped = 0;
    const seen = new Set();
    let dups = 0;
    for (let i = h + 1; i < aoa.length; i++) {
      const line = aoa[i];
      if (!line) continue;
      const idRaw = line[idx['Номер задачи']];
      const id = typeof idRaw === 'number' ? idRaw : Number(String(idRaw == null ? '' : idRaw).trim());
      if (!Number.isFinite(id) || id <= 0) { // строки-заголовки групп «Статус: В работе (743)» и пустые
        if (cleanStr(idRaw)) skipped++;
        continue;
      }
      if (seen.has(id)) { dups++; continue; }
      seen.add(id);
      const r = {};
      for (const title in COLS) {
        const key = COLS[title];
        const raw = idx[title] === undefined ? null : line[idx[title]];
        if (key === 'id') r.id = id;
        else if (DATE_KEYS.includes(key)) r[key] = toISO(raw);
        else if (key === 'shop') {
          const n = raw === null || raw === '' ? null : Number(raw);
          r.shop = Number.isFinite(n) ? n : null;
        } else r[key] = cleanStr(raw);
      }
      rows.push(r);
    }
    const absentOptional = Object.keys(COLS).filter((c) => idx[c] === undefined && !REQUIRED.includes(c));
    return { rows, skippedGroupRows: skipped, duplicates: dups, absentOptional };
  }

  /* ---------- область отслеживания ---------- */
  function mkSets(scope) {
    return {
      regions: new Set(scope.regions),
      brands: new Set(scope.brands),
      tt: new Set(scope.tt),
      stages: new Set(scope.stages),
    };
  }
  // подходит по региону/бренду/типу ТТ (этап не смотрим)
  function passFilter(r, S) {
    return S.regions.has(normRegion(r.region)) && S.brands.has(r.brand) && S.tt.has(r.tt);
  }
  function inScope(r, S) { return passFilter(r, S) && S.stages.has(r.stage); }
  function isOverdue(r, date) { return !!(r.due && r.due < date); }
  function person(r) { return r.searcher || NO_PERSON; }

  function stageCounts(rows, S, date) {
    const byStage = {};
    let total = 0, overdue = 0, noDue = 0;
    for (const r of rows) {
      if (!inScope(r, S)) continue;
      total++;
      byStage[r.stage] = (byStage[r.stage] || 0) + 1;
      if (isOverdue(r, date)) overdue++;
      if (!r.due) noDue++;
    }
    return { total, byStage, overdue, noDue };
  }

  /* ---------- сравнение двух выгрузок ---------- */
  const KINDS = ['new', 'enter', 'advance', 'back', 'exit', 'same'];

  function emptyN() { return { new: 0, enter: 0, advance: 0, back: 0, exit: 0, same: 0 }; }

  function compare(A, B, scope) {
    const S = mkSets(scope);
    const ia = new Map(A.rows.map((r) => [r.id, r]));
    const ib = new Map(B.rows.map((r) => [r.id, r]));
    const ids = new Set([...ia.keys(), ...ib.keys()]);

    const events = [];
    let outsideNew = 0; // новые задачи, не попавшие в область (например, ещё «В работе»)
    const matrix = new Map(); // "from|to" → count
    const NEW = '— новая задача —', GONE = '— нет в выгрузке —', OTHER = '(другой регион/бренд/тип)';
    const bump = (f, t) => { const k = f + '\u0001' + t; matrix.set(k, (matrix.get(k) || 0) + 1); };

    for (const id of ids) {
      const a = ia.get(id), b = ib.get(id);
      const sa = !!a && inScope(a, S), sb = !!b && inScope(b, S);
      const fa = !!a && passFilter(a, S), fb = !!b && passFilter(b, S);

      // матрица переходов: берём задачи, у которых хотя бы с одной стороны отслеживаемый этап
      if (sa || sb) {
        bump(!a ? NEW : fa ? a.stage : OTHER, !b ? GONE : fb ? b.stage : OTHER);
      }

      let kind = null, sub = null;
      if (!a) {
        if (sb) kind = 'new'; else outsideNew++;
      } else if (!b) {
        if (sa) { kind = 'exit'; sub = 'gone'; }
      } else if (sa && sb) {
        const ra = STAGE_RANK[a.stage], rb = STAGE_RANK[b.stage];
        if (a.stage === b.stage) kind = 'same';
        else if (ra === undefined || rb === undefined || rb > ra) kind = 'advance';
        else kind = 'back';
      } else if (!sa && sb) {
        kind = 'enter';
      } else if (sa && !sb) {
        kind = 'exit';
        if (!fb) sub = 'filter';
        else if ((STAGE_RANK[b.stage] ?? 99) > (STAGE_RANK[a.stage] ?? -1)) sub = 'beyond';
        else sub = 'behind';
      }
      if (!kind) continue;

      const cur = b || a;
      const ev = {
        id, kind, sub,
        who: person(cur),
        a: a || null, b: b || null,
        fromStage: a ? a.stage : null,
        toStage: b ? b.stage : null,
        row: cur,
        overdueA: a ? isOverdue(a, A.date) : false,
        overdueB: b ? isOverdue(b, B.date) : false,
        reassignedFrom: a && b && person(a) !== person(b) ? person(a) : null,
        dueChange: null,
      };
      if (a && b && a.due !== b.due) {
        ev.dueChange = {
          from: a.due, to: b.due,
          days: a.due && b.due ? daysBetween(a.due, b.due) : null,
        };
      }
      events.push(ev);
    }

    // по сотрудникам
    const people = new Map();
    const get = (name) => {
      if (!people.has(name)) {
        people.set(name, {
          name, n: emptyN(), events: [],
          before: { total: 0, byStage: {}, overdue: 0 },
          after: { total: 0, byStage: {}, overdue: 0 },
        });
      }
      return people.get(name);
    };
    for (const r of A.rows) {
      if (!inScope(r, S)) continue;
      const p = get(person(r));
      p.before.total++;
      p.before.byStage[r.stage] = (p.before.byStage[r.stage] || 0) + 1;
      if (isOverdue(r, A.date)) p.before.overdue++;
    }
    for (const r of B.rows) {
      if (!inScope(r, S)) continue;
      const p = get(person(r));
      p.after.total++;
      p.after.byStage[r.stage] = (p.after.byStage[r.stage] || 0) + 1;
      if (isOverdue(r, B.date)) p.after.overdue++;
    }
    for (const ev of events) {
      const p = get(ev.who);
      p.n[ev.kind]++;
      p.events.push(ev);
    }

    const sumN = emptyN();
    for (const ev of events) sumN[ev.kind]++;

    return {
      A: { date: A.date }, B: { date: B.date },
      days: daysBetween(A.date, B.date),
      events, people: [...people.values()],
      before: stageCounts(A.rows, S, A.date),
      after: stageCounts(B.rows, S, B.date),
      n: sumN, outsideNew,
      matrix: [...matrix.entries()].map(([k, v]) => { const [f, t] = k.split('\u0001'); return { from: f, to: t, n: v }; }),
      specials: { NEW, GONE, OTHER },
    };
  }

  /* ---------- история одной задачи по всем выгрузкам ---------- */
  function taskHistory(snapshots, id) {
    const out = [];
    for (const s of snapshots) {
      const r = s.rows.find((x) => x.id === id);
      out.push({ date: s.date, row: r || null });
    }
    return out.sort((x, y) => (x.date < y.date ? -1 : 1));
  }

  // сколько снимков подряд (с конца) задача стоит на одном этапе → дата «не позже чем»
  function stageSince(hist) {
    let i = hist.length - 1;
    if (i < 0 || !hist[i].row) return null;
    const st = hist[i].row.stage;
    while (i > 0 && hist[i - 1].row && hist[i - 1].row.stage === st) i--;
    return { stage: st, since: hist[i].date, snapshots: hist.length - i };
  }

  /* ---------- сколько в области по каждой выгрузке (для тренда) ---------- */
  function trend(snapshots, scope) {
    const S = mkSets(scope);
    return snapshots
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((s) => ({ date: s.date, ...stageCounts(s.rows, S, s.date) }));
  }

  function personTrend(snapshots, scope, name) {
    const S = mkSets(scope);
    return snapshots
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((s) => {
        const rows = s.rows.filter((r) => person(r) === name);
        return { date: s.date, ...stageCounts(rows, S, s.date) };
      });
  }

  root.Core = {
    STAGES, STAGE_RANK, DEFAULT_SCOPE, COLS, REQUIRED, KINDS, NO_PERSON,
    normRegion, toISO, serialToISO, daysBetween, guessDateFromName,
    parseAoa, mkSets, passFilter, inScope, isOverdue, person,
    stageCounts, compare, taskHistory, stageSince, trend, personTrend,
  };
})(typeof window !== 'undefined' ? window : globalThis);
