/* Шифрование и хранение.
   - vault.json в репозитории: все выгрузки, сжаты gzip и зашифрованы AES-GCM-256,
     ключ = PBKDF2-SHA256(пароль, соль, 250 000 итераций). Без пароля там нечего читать.
   - IndexedDB в браузере: выгрузки, загруженные кнопкой, тоже шифруются этим же ключом. */
(function (root) {
  'use strict';

  const ITER = 250000;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function b64e(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64d(str) {
    const s = atob(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  async function deriveKey(password, salt, iter) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: iter || ITER, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function gzip(bytes) {
    const cs = new CompressionStream('gzip');
    const w = cs.writable.getWriter();
    w.write(bytes); w.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  }
  async function gunzip(bytes) {
    const ds = new DecompressionStream('gzip');
    const w = ds.writable.getWriter();
    w.write(bytes); w.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  }

  async function encryptObj(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = await gzip(enc.encode(JSON.stringify(obj)));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
    return { iv: b64e(iv), ct: b64e(ct) };
  }
  async function decryptObj(key, rec) {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(rec.iv) }, key, b64d(rec.ct));
    return JSON.parse(dec.decode(await gunzip(new Uint8Array(plain))));
  }

  /* ---------- vault.json ---------- */
  async function openVault(vault, password) {
    const salt = b64d(vault.salt);
    const key = await deriveKey(password, salt, vault.iter);
    // неверный пароль → decrypt бросит исключение
    const data = await decryptObj(key, vault);
    return { key, snapshots: data.snapshots || [], saltId: vault.salt };
  }

  async function buildVault(password, snapshots) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(password, salt, ITER);
    const rec = await encryptObj(key, { snapshots });
    return { v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt: b64e(salt), iv: rec.iv, ct: rec.ct };
  }

  /* ---------- IndexedDB: локальные загрузки ---------- */
  const DB = 'funnel-tracker', STORE = 'snapshots';
  function idb() {
    return new Promise((res, rej) => {
      if (!root.indexedDB) return rej(new Error('IndexedDB недоступна'));
      const q = indexedDB.open(DB, 1);
      q.onupgradeneeded = () => q.result.createObjectStore(STORE, { keyPath: 'date' });
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  }
  async function tx(mode, fn) {
    const db = await idb();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
      t.onerror = () => rej(t.error);
    });
  }

  async function localSave(key, saltId, snap) {
    const rec = await encryptObj(key, snap);
    await tx('readwrite', (s) => s.put({ date: snap.date, saltId, iv: rec.iv, ct: rec.ct }));
  }
  async function localDelete(date) { await tx('readwrite', (s) => s.delete(date)); }
  async function localClear() { await tx('readwrite', (s) => s.clear()); }

  // → { snapshots, skipped }  skipped — записи, которые не открылись этим паролем
  async function localLoad(key, saltId) {
    let recs = [];
    try { recs = await tx('readonly', (s) => s.getAll()); } catch (e) { return { snapshots: [], skipped: 0, unavailable: true }; }
    const snapshots = []; let skipped = 0;
    for (const r of recs) {
      if (r.saltId !== saltId) { skipped++; continue; }
      try { snapshots.push(await decryptObj(key, r)); } catch (e) { skipped++; }
    }
    return { snapshots, skipped };
  }

  root.Vault = { openVault, buildVault, localSave, localDelete, localClear, localLoad, deriveKey, encryptObj, decryptObj, ITER };
})(window);
