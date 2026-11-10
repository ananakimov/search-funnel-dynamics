#!/usr/bin/env python3
"""Собирает зашифрованный vault.json из одной или нескольких выгрузок xlsx.

Обычно это нужно один раз (начальные данные). Дальше выгрузки загружаются кнопкой
в самом приложении, а «Скачать vault.json» на вкладке «Выгрузки» обновляет файл.

  pip install openpyxl cryptography
  VAULT_PASSWORD='...' python3 tools/build_vault.py \
      --xlsx "Воронка_файл_3_ноября.xlsx" --date 2026-11-03 \
      --xlsx "Воронка_файл_10_ноября.xlsx" --date 2026-11-10 \
      --out vault.json

Формат: gzip(JSON{snapshots}) → AES-GCM-256, ключ PBKDF2-SHA256(пароль, соль, 250000).
Парсинг колонок зеркалит js/core.js (parseAoa) — менять нужно в обоих местах.
"""
import argparse, base64, gzip, hashlib, json, os, sys, re
from datetime import datetime, date

import openpyxl
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

COLS = {
    'Номер задачи': 'id', 'Регион': 'region', 'Адрес': 'address', 'Номер торговой точки': 'shop',
    'Сотрудник отдела поиска': 'searcher', 'Менеджер по развитию': 'devManager', 'Статус ТТ': 'tt',
    'Бренд': 'brand', 'Дата создания': 'created', 'Статус': 'stage', 'Заказчик': 'customer',
    'Исполнитель': 'executor', 'Второе подтверждение': 'confirm2', 'Территория': 'territory',
    'Проектный менеджер': 'pm', 'Юрисконсульт': 'lawyer', 'Руководитель строительного отдела': 'builder',
    'Срок': 'due', 'Фактическая дата открытия (первая тыс.)': 'openedAt',
}
REQUIRED = ['Номер задачи', 'Адрес', 'Регион', 'Сотрудник отдела поиска', 'Статус', 'Статус ТТ', 'Бренд']
ITER = 250000


def clean(v):
    if v is None:
        return None
    s = re.sub(r'\s+', ' ', str(v)).strip()
    return s or None


def to_iso(v):
    if v is None or v == '':
        return None
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    s = str(v).strip()
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})', s)
    if m:
        return '-'.join(m.groups())
    m = re.match(r'^(\d{1,2})\.(\d{1,2})\.(\d{4})', s)
    if m:
        return f'{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}'
    return None


def parse(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb['Открытия'] if 'Открытия' in wb.sheetnames else wb.worksheets[0]
    rows = [list(r) for r in ws.iter_rows(values_only=True)]
    h = next((i for i, r in enumerate(rows[:15]) if any(clean(c) == 'Номер задачи' for c in r)), None)
    if h is None:
        sys.exit(f'{path}: не нашёл строку заголовков')
    head = [clean(c) for c in rows[h]]
    idx = {}
    for i, t in enumerate(head):
        if t in COLS and t not in idx:
            idx[t] = i
    miss = [c for c in REQUIRED if c not in idx]
    if miss:
        sys.exit(f'{path}: нет колонок {miss}')
    out, seen = [], set()
    for line in rows[h + 1:]:
        raw = line[idx['Номер задачи']]
        try:
            tid = int(raw)
        except (TypeError, ValueError):
            continue
        if tid <= 0 or tid in seen:
            continue
        seen.add(tid)
        r = {}
        for title, key in COLS.items():
            val = line[idx[title]] if title in idx and idx[title] < len(line) else None
            if key == 'id':
                r['id'] = tid
            elif key in ('created', 'due', 'openedAt'):
                r[key] = to_iso(val)
            elif key == 'shop':
                try:
                    r['shop'] = int(float(val)) if val not in (None, '') else None
                except ValueError:
                    r['shop'] = None
            else:
                r[key] = clean(val)
        out.append(r)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--xlsx', action='append', required=True)
    ap.add_argument('--date', action='append', required=True, help='дата выгрузки YYYY-MM-DD, по одной на каждый --xlsx')
    ap.add_argument('--out', default='vault.json')
    a = ap.parse_args()
    if len(a.xlsx) != len(a.date):
        sys.exit('--xlsx и --date должны идти парами')
    pw = os.environ.get('VAULT_PASSWORD')
    if not pw:
        sys.exit('Задайте пароль в переменной окружения VAULT_PASSWORD')

    snaps = []
    for p, d in zip(a.xlsx, a.date):
        datetime.strptime(d, '%Y-%m-%d')
        rows = parse(p)
        snaps.append({'date': d, 'fileName': os.path.basename(p), 'uploadedAt': datetime.utcnow().isoformat() + 'Z', 'rows': rows})
        print(f'{p}: {len(rows)} строк, дата {d}')

    salt, iv = os.urandom(16), os.urandom(12)
    key = hashlib.pbkdf2_hmac('sha256', pw.encode(), salt, ITER, 32)
    plain = gzip.compress(json.dumps({'snapshots': snaps}, ensure_ascii=False, separators=(',', ':')).encode(), mtime=0)
    ct = AESGCM(key).encrypt(iv, plain, None)  # ciphertext||tag — как ждёт WebCrypto
    vault = {'v': 1, 'kdf': 'PBKDF2-SHA256', 'iter': ITER,
             'salt': base64.b64encode(salt).decode(), 'iv': base64.b64encode(iv).decode(),
             'ct': base64.b64encode(ct).decode()}
    with open(a.out, 'w') as f:
        json.dump(vault, f)
    print(f'→ {a.out}, {os.path.getsize(a.out) // 1024} КБ')


if __name__ == '__main__':
    main()
