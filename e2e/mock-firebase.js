// In-memory Firebase compat mock for E2E. Replaces the gstatic firebase-*-compat.js
// scripts so the app NEVER talks to the real Firestore/Auth project.
(function () {
  if (window.firebase) return;
  const store = new Map();           // path(collection) -> Map(id -> data)
  const listeners = new Set();       // {path, orderBy, cb}
  const accounts = new Map();        // email -> password
  let authUser = null;
  const authCbs = [];
  let seq = 0;
  let offline = false;
  let writeCount = 0;

  class Timestamp {
    constructor(seconds, nanoseconds) { this.seconds = seconds; this.nanoseconds = nanoseconds || 0; }
    toDate() { return new Date(this.seconds * 1000); }
    toMillis() { return this.seconds * 1000; }
    static now() { const ms = Date.now() + (seq++); return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6); }
  }
  const SERVER_TS = { __serverTs: true };
  const DELETE = { __delete: true };

  function col(path) { if (!store.has(path)) store.set(path, new Map()); return store.get(path); }
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function resolve(data) {
    const out = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === SERVER_TS) out[k] = Timestamp.now();
      else if (v instanceof Timestamp) out[k] = new Timestamp(v.seconds, v.nanoseconds);
      else out[k] = v;
    }
    return out;
  }
  function hydrate(obj) { // restore Timestamp instances after clone
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = (v && typeof v === 'object' && typeof v.seconds === 'number' && 'nanoseconds' in v && Object.keys(v).length === 2)
        ? new Timestamp(v.seconds, v.nanoseconds) : v;
    }
    return out;
  }

  function checkPerm(path, id) {
    // Mirrors firestore.rules
    const email = authUser ? authUser.email.toLowerCase() : null;
    const parts = path.split('/');
    if (parts[0] === 'users') {
      const safeId = parts.length === 1 ? id : parts[1];
      const exists = parts.length === 1 && col('users').has(id);
      if (parts.length === 1 && !exists) return; // get on missing doc allowed
      if (!email || email !== (safeId + '@ierp.local').toLowerCase()) {
        const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e;
      }
    }
    if (parts[0] === 'emailIndex' && (!email || email !== String(id).toLowerCase())) {
      const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e;
    }
  }

  function notify(path) {
    listeners.forEach((l) => { if (l.path === path) fire(l); });
  }
  function fire(l) {
    let docs = Array.from(col(l.path).entries()).map(([id, d]) => ({ id, d }));
    if (l.orderBy) {
      const { field, dir } = l.orderBy;
      docs = docs.filter((x) => x.d[field] !== undefined && x.d[field] !== null); // Firestore drops docs missing the orderBy field
      docs.sort((a, b) => {
        let va = a.d[field], vb = b.d[field];
        if (va instanceof Timestamp) va = va.toMillis();
        if (vb instanceof Timestamp) vb = vb.toMillis();
        const c = va < vb ? -1 : va > vb ? 1 : 0;
        return dir === 'desc' ? -c : c;
      });
    }
    const list = docs.map(({ id, d }) => ({ id, data: () => hydrate(clone(d)) }));
    // 실제 Firestore처럼 추가/변경/삭제를 모두 docChanges에 담는다 (마지막 문서가
    // 지워져 목록이 비는 경우에도 'removed' 변경이 보고되어야 함)
    const prev = l.prevIds || new Set();
    const now = new Set(list.map((x) => x.id));
    const changes = list.map((doc) => ({ type: prev.has(doc.id) ? 'modified' : 'added', doc }));
    prev.forEach((id) => { if (!now.has(id)) changes.push({ type: 'removed', doc: { id, data: () => ({}) } }); });
    l.prevIds = now;
    const snap = { docs: list, metadata: { fromCache: offline }, docChanges: () => changes };
    setTimeout(() => l.cb(snap), 0);
  }
  // 연결 상태만 바뀐(문서 변화 없는) 메타데이터 스냅샷 — includeMetadataChanges 구독자에게만
  function fireMeta(l) {
    if (!l.includeMeta) return;
    let docs = Array.from(col(l.path).entries()).map(([id, d]) => ({ id, data: () => hydrate(clone(d)) }));
    const snap = { docs, metadata: { fromCache: offline }, docChanges: () => [] };
    setTimeout(() => l.cb(snap), 0);
  }

  function writeSet(path, id, data, merge) {
    checkPerm(path, id);
    const c = col(path);
    const resolved = resolve(data);
    const base = merge && c.has(id) ? c.get(id) : {};
    writeCount++;
    const next = { ...base, ...resolved };
    Object.keys(next).forEach((k) => { if (next[k] === DELETE) delete next[k]; });
    c.set(id, next);
  }

  function docRef(path, id) {
    return {
      id,
      async get() {
        checkPerm(path, id);
        const d = col(path).get(id);
        return { id, exists: !!d, data: () => (d ? hydrate(clone(d)) : undefined) };
      },
      async set(data, opts) { writeSet(path, id, data, opts && opts.merge); notify(path); },
      async update(data) {
        checkPerm(path, id);
        if (!col(path).has(id)) { const e = new Error('No document to update'); e.code = 'not-found'; throw e; }
        writeSet(path, id, data, true); notify(path);
      },
      async delete() { checkPerm(path, id); writeCount++; col(path).delete(id); notify(path); }
    };
  }

  function query(path, orderBy) {
    return {
      orderBy(field, dir) { return query(path, { field, dir: dir || 'asc' }); },
      doc(id) { return docRef(path, id || ('auto_' + (++seq))); },
      async add(data) { const id = 'auto_' + (++seq) + '_' + Math.random().toString(36).slice(2, 7); await docRef(path, id).set(data); return { id }; },
      async get() {
        checkPerm(path, '');
        const docs = Array.from(col(path).entries()).map(([id, d]) => ({ id, data: () => hydrate(clone(d)) }));
        return { docs, size: docs.length, empty: !docs.length };
      },
      onSnapshot(a, b, c) {
        const opts = (a && typeof a === 'object') ? a : {};
        const cb = (a && typeof a === 'object') ? b : a;
        const errCb = (a && typeof a === 'object') ? c : b;
        const l = { path, orderBy, cb, includeMeta: !!opts.includeMetadataChanges };
        try { checkPerm(path, ''); } catch (e) { setTimeout(() => errCb && errCb(e), 0); return () => {}; }
        listeners.add(l); fire(l);
        return () => listeners.delete(l);
      }
    };
  }

  const firestoreInstance = {
    collection: (path) => query(path, null),
    async runTransaction(fn) {
      const touched = [];
      const tx = {
        get: (ref) => ref.get(),
        set: (ref, data, opts) => { touched.push(() => ref.set(data, opts)); }
      };
      const r = await fn(tx);
      for (const t of touched) await t();
      return r;
    },
    batch() {
      const ops = [];
      return {
        set: (ref, data, opts) => ops.push(() => ref.set(data, opts)),
        delete: (ref) => ops.push(() => ref.delete()),
        async commit() { for (const o of ops) await o(); }
      };
    }
  };
  const firestoreFn = () => firestoreInstance;
  firestoreFn.FieldValue = { serverTimestamp: () => SERVER_TS, delete: () => DELETE };
  firestoreFn.Timestamp = Timestamp;

  function mkUser(email) {
    return {
      email,
      async updatePassword(pw) { accounts.set(email, pw); window.__mockFb.pwChanges++; }
    };
  }
  function setAuth(u) { authUser = u; authInstance.currentUser = u; authCbs.forEach((cb) => cb(u)); }
  const authInstance = {
    currentUser: null,
    onAuthStateChanged(cb) { authCbs.push(cb); setTimeout(() => cb(authUser), 0); },
    async setPersistence() {},
    async createUserWithEmailAndPassword(email, pw) {
      email = email.toLowerCase();
      if (accounts.has(email)) { const e = new Error('in use'); e.code = 'auth/email-already-in-use'; throw e; }
      accounts.set(email, pw); setAuth(mkUser(email)); return { user: authUser };
    },
    async signInWithEmailAndPassword(email, pw) {
      email = email.toLowerCase();
      if (accounts.get(email) !== pw) { const e = new Error('INVALID_LOGIN_CREDENTIALS'); e.code = 'auth/invalid-credential'; throw e; }
      setAuth(mkUser(email)); return { user: authUser };
    },
    async signOut() { setAuth(null); }
  };
  const authFn = () => authInstance;
  authFn.Auth = { Persistence: { LOCAL: 'local', SESSION: 'session', NONE: 'none' } };

  window.firebase = { initializeApp: () => ({}), auth: authFn, firestore: firestoreFn };
  window.__mockFb = {
    store, pwChanges: 0,
    dump(path) { return Array.from(col(path).entries()).map(([id, d]) => ({ id, ...clone(d) })); },
    paths() { return Array.from(store.keys()); },
    get writes() { return writeCount; },
    setOffline(v) { offline = !!v; listeners.forEach(fireMeta); }
  };
})();
