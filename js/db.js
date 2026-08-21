// ══════════════════════════════════════════════════════════════
// db.js — Firestore 연결 · 저장/조회 공통 함수 · 실시간 리스너
// iERP 2.0 / 2단계 모듈
//
// 의존성: security.js (rawNum 등은 안 쓰지만, 로딩 순서 규칙상
//         항상 security.js 다음에 둔다)
//
// 설계 원칙 (iERP 1.0에서 배운 것):
//   1. 문서 경로에 배열 인덱스를 절대 쓰지 않는다. 이 파일의 genId()로
//      만든 고유 ID만 경로에 사용한다. (1.0에서 인덱스를 경로에 써서
//      회사 삭제 시 데이터가 엉키는 사고가 있었음 — 구조적으로 재발 불가)
//   2. 리스너 연결(listen)은 그 자체로 독립적으로 동작해야 하며,
//      "로그인 후 처리할 다른 초기화 작업"에서 예외가 나더라도
//      리스너 연결 자체는 이미 끝나 있어야 한다. main.js에서
//      DBEngine.listen(...)을 제일 먼저 호출하고, 나머지 화면
//      초기화는 그 뒤에 순서 상관없이 실행한다.
//      (1.0에서 로그인 후처리 코드 중간에 정의되지 않은 함수를 호출해
//      예외가 나면서, 그 아래 있던 리스너 연결 코드 자체가 아예
//      실행되지 못했던 사고가 있었음 — 이게 "연결 중..."에서 몇 시간을
//      멈춰 있던 근본 원인이었다.)
//   3. 리스너가 끊기면 자동으로 재연결을 시도하고, 실패 이유를
//      콘솔에 정확히 남긴다. 화면에는 상태(연결 중/동기화 중/오프라인)를
//      항상 보여준다.
// ══════════════════════════════════════════════════════════════

let db = null;

/**
 * Firebase 앱과 Firestore를 초기화합니다. main.js에서 제일 먼저 호출합니다.
 * @param {object} firebaseConfig
 * @returns {firebase.firestore.Firestore}
 */
function initFirebaseDb(firebaseConfig) {
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
  return db;
}

/**
 * 새 문서용 고유 ID를 생성합니다. 회사/거래처/품목 등 하위 개체를
 * 새로 만들 때 반드시 이 함수로 ID를 발급하고, 그 ID를 문서 경로에
 * 사용합니다. (배열 인덱스를 경로에 쓰지 않는다는 원칙의 실제 구현)
 * @returns {string}
 */
function genId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

// ── 공통 CRUD ──────────────────────────────────────────────

/**
 * 컬렉션에 새 문서를 추가합니다 (자동 ID, 생성시각 자동 기록).
 * @param {string} path - 예: `users/{safeId}/companies/{companyId}/customers`
 * @param {object} data
 */
async function addDoc(path, data) {
  return await db.collection(path).add({
    ...data,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

/**
 * 지정한 ID로 문서를 생성하거나 덮어씁니다.
 * @param {string} path
 * @param {string} id
 * @param {object} data
 * @param {boolean} merge - true면 기존 필드를 유지하며 병합
 */
async function setDoc(path, id, data, merge = false) {
  return await db.collection(path).doc(id).set(data, { merge });
}

/** 문서 일부 필드를 수정합니다. */
async function updateDoc(path, id, data) {
  return await db.collection(path).doc(id).update(data);
}

/** 문서를 삭제합니다. */
async function deleteDoc(path, id) {
  return await db.collection(path).doc(id).delete();
}

/** 문서 하나를 단발성으로 조회합니다 (실시간 구독 아님). */
async function getDocOnce(path, id) {
  const snap = await db.collection(path).doc(id).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

/** 필드 삭제용 상수 (updateDoc에서 특정 필드를 지울 때 사용) */
const DELETE_FIELD = () => firebase.firestore.FieldValue.delete();

// ── 실시간 리스너 관리 ──────────────────────────────────────

const DbEngine = (() => {
  let activeUnsubscribers = [];
  let statusListeners = [];
  let currentStatus = 'connecting'; // 'connecting' | 'synced' | 'offline'

  /** 상태(연결 중/동기화 중/오프라인)가 바뀔 때마다 호출될 콜백을 등록합니다. */
  function onStatusChange(cb) {
    statusListeners.push(cb);
  }

  function setStatus(status) {
    currentStatus = status;
    statusListeners.forEach((cb) => cb(status));
  }

  function getStatus() {
    return currentStatus;
  }

  /** 지금 열려있는 모든 리스너를 해제합니다 (회사 전환, 로그아웃 시 호출). */
  function stopAll() {
    activeUnsubscribers.forEach((u) => u());
    activeUnsubscribers = [];
  }

  /**
   * 컬렉션을 실시간 구독합니다. 최소 하나의 리스너라도 정상 응답하면
   * 상태를 'synced'로 표시합니다.
   * @param {string} path
   * @param {object} options
   * @param {{field:string, direction?:string}} [options.orderBy]
   * @param {(docs: object[]) => void} options.onData
   */
  function listen(path, { orderBy, onData }) {
    let query = db.collection(path);
    if (orderBy) query = query.orderBy(orderBy.field, orderBy.direction || 'desc');

    const unsub = query.onSnapshot(
      (snap) => {
        setStatus('synced');
        onData(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      },
      (err) => {
        // 원인을 반드시 콘솔에 남긴다 — 1.0에서 이 로그가 없어서
        // "왜 안 되는지" 알아내는 데 하루 이상 걸렸던 적이 있다.
        console.error(`[DbEngine] "${path}" 구독 실패:`, err.code, err.message);
        setStatus('offline');
      }
    );
    activeUnsubscribers.push(unsub);
    return unsub;
  }

  /**
   * 연결이 오래 'connecting' 상태로 멈춰 있으면 주어진 재시도 함수를
   * 반복 호출합니다. main.js에서 로그인 직후 한 번 호출합니다.
   * @param {() => void} retryFn - 다시 시도할 때 실행할 함수 (보통 stopAll() 후 listen들을 다시 건다)
   * @param {object} [opts]
   */
  function startReconnectWatchdog(retryFn, { intervalMs = 3000, maxAttempts = 10 } = {}) {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      if (currentStatus === 'connecting') {
        console.warn(`[DbEngine] 재연결 시도 ${attempts}/${maxAttempts}`);
        retryFn();
      } else {
        clearInterval(timer);
      }
      if (attempts >= maxAttempts) clearInterval(timer);
    }, intervalMs);
    return () => clearInterval(timer);
  }

  return { onStatusChange, setStatus, getStatus, stopAll, listen, startReconnectWatchdog };
})();

// 다른 모듈에서 전역으로 사용
window.initFirebaseDb = initFirebaseDb;
window.genId = genId;
window.addDoc = addDoc;
window.setDoc = setDoc;
window.updateDoc = updateDoc;
window.deleteDoc = deleteDoc;
window.getDocOnce = getDocOnce;
window.DELETE_FIELD = DELETE_FIELD;
window.DbEngine = DbEngine;
