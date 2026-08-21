// ══════════════════════════════════════════════════════════════
// auth.js — 로그인 · 회원가입 · 자동 로그인 복원
// iERP 2.0 / 3단계 모듈
//
// 의존성: security.js, db.js
// 이 파일이 올바르게 동작하려면 firestore.rules(동봉)이 함께
// 게시되어 있어야 합니다.
//
// 설계 원칙 (iERP 1.0에서 배운 것):
//   1. Firebase Auth는 이메일을 항상 소문자로 저장한다. 그런데
//      아이디를 안전한 문자열(safeId)로 바꿀 때 쓰는 인코딩은
//      대소문자가 섞여 나온다. 그래서 "소문자 이메일 → 원래 safeId"를
//      찾는 색인(emailIndex)을 매 로그인마다 갱신해두고, 새로고침
//      복원 시에는 이 색인을 거쳐서 safeId를 찾는다.
//      (1.0에서는 이걸 안 해서, 새로고침할 때마다 로그인 화면으로
//      튕기는 버그가 있었다.)
//   2. Firebase가 "존재하지 않는 계정"과 "비밀번호 틀림"을 하나의
//      애매한 에러 코드로 합쳐서 반환하는 경우가 있어, 에러 코드
//      이름만으로 판단하지 않는다. 대신 로그인 실패 후 Firestore
//      문서를 읽어본 결과(문서 없음 / 읽기 자체가 거부됨)로 실제
//      상황을 판별한다.
//   3. 1.0에는 있었던 "레거시 평문 계정 자동 전환" 로직은 여기 없다.
//      처음부터 Firebase Auth로만 가입하므로 애초에 그럴 일이 없다.
// ══════════════════════════════════════════════════════════════

let authInstance = null;
let currentUser = null;      // { id, safeId }
let companies = [];          // 이 계정이 관리하는 회사 목록
let activeCoIdx = 0;

let manualLoginInProgress = false; // doLogin/doRegister 진행 중엔 자동복원 로직이 끼어들지 않게 막는 플래그
let authReadyFired = false;
let authReadyCallbacks = [];

/** 아이디 문자열을 문서 경로/이메일에 쓸 안전한 문자열로 변환합니다. */
function computeSafeId(username) {
  return btoa(encodeURIComponent(username)).replace(/[^a-zA-Z0-9]/g, '_');
}

/** safeId로부터 Firebase Auth용 가상 이메일을 만듭니다. */
function authEmailOf(safeId) {
  return safeId + '@ierp.local';
}

/** 지금 선택된 회사의 고유 ID를 반환합니다. (Firestore 하위 경로에 사용) */
function curCompanyId() {
  return companies[activeCoIdx]?.id;
}

function defaultCompanyFields() {
  return {
    bizno: '', ceo: '', biztype: '', bizitem: '', addr: '', tel: '', fax: '',
    email: '', bank: '', account: '', accountname: '', terms: '', footer: ''
  };
}

function applyUserDoc(safeId, data) {
  currentUser = { id: data.displayId || safeId, safeId };
  companies = data.companies || [];
  activeCoIdx = data.activeCoIdx || 0;
}

// ── 초기화 / 자동 복원 ──────────────────────────────────────

/**
 * Firebase Auth를 초기화하고, 새로고침 시 로그인 복원을 시도합니다.
 * main.js에서 initFirebaseDb() 다음, 다른 무엇보다도 먼저 호출합니다.
 */
function initAuth() {
  authInstance = firebase.auth();

  authInstance.onAuthStateChanged(async (user) => {
    if (manualLoginInProgress) return; // doLogin()/doRegister()이 직접 처리 중이면 무시

    if (user && !currentUser) {
      try {
        const emailLower = (user.email || '').toLowerCase();
        if (emailLower) {
          const idx = await getDocOnce('emailIndex', emailLower);
          const safeId = idx ? idx.safeId : emailLower.split('@')[0];
          if (safeId) {
            const userDoc = await getDocOnce('users', safeId);
            if (!userDoc) {
              await authInstance.signOut();
            } else {
              if (!idx) await setDoc('emailIndex', emailLower, { safeId }); // 색인이 없던 경우 지금 채워둠
              applyUserDoc(safeId, userDoc);
            }
          }
        }
      } catch (e) {
        console.error('[auth] 자동 로그인 복원 실패:', e);
      }
    }
    fireAuthReady();
  });
}

/**
 * 로그인 상태 확인이 끝났을 때 한 번 호출됩니다 (로그인 성공/실패 여부와 무관 —
 * "이제 로그인 화면을 보여줄지 메인 화면을 보여줄지 판단해도 된다"는 신호).
 * 화면(레이아웃 셸)의 로딩 스플래시를 내리는 시점으로 사용합니다.
 */
function onAuthReady(cb) {
  if (authReadyFired) cb();
  else authReadyCallbacks.push(cb);
}
function fireAuthReady() {
  if (authReadyFired) return;
  authReadyFired = true;
  authReadyCallbacks.forEach((cb) => cb());
  authReadyCallbacks = [];
}

// ── 회원가입 / 로그인 / 로그아웃 ────────────────────────────

/**
 * @param {{username:string, password:string, company:string}} params
 * @returns {Promise<{id:string, safeId:string}>}
 */
async function doRegister({ username, password, company }) {
  if (!username || !password || !company) throw new Error('아이디, 비밀번호, 상호명은 필수입니다');
  if (password.length < 6) throw new Error('비밀번호는 6자 이상이어야 합니다');

  const safeId = computeSafeId(username);
  const email = authEmailOf(safeId);
  manualLoginInProgress = true;
  try {
    const existing = await getDocOnce('users', safeId);
    if (existing) throw new Error('이미 사용 중인 아이디입니다');

    await authInstance.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    try {
      await authInstance.createUserWithEmailAndPassword(email, password);
    } catch (err) {
      if (err.code === 'auth/email-already-in-use') throw new Error('이미 사용 중인 아이디입니다');
      throw err;
    }

    const companyData = { id: genId(), company, ...defaultCompanyFields() };
    const userData = { displayId: username, companies: [companyData], activeCoIdx: 0, createdAt: new Date().toISOString() };
    await setDoc('users', safeId, userData);
    await setDoc('emailIndex', email.toLowerCase(), { safeId });

    applyUserDoc(safeId, userData);
    return currentUser;
  } finally {
    manualLoginInProgress = false;
  }
}

/**
 * @param {{username:string, password:string, keepLoggedIn:boolean}} params
 * @returns {Promise<{id:string, safeId:string}>}
 */
async function doLogin({ username, password, keepLoggedIn }) {
  if (!username || !password) throw new Error('아이디와 비밀번호를 입력하세요');

  const safeId = computeSafeId(username);
  const email = authEmailOf(safeId);
  manualLoginInProgress = true;
  try {
    await authInstance.setPersistence(
      keepLoggedIn ? firebase.auth.Auth.Persistence.LOCAL : firebase.auth.Auth.Persistence.SESSION
    );

    try {
      await authInstance.signInWithEmailAndPassword(email, password);
    } catch (err) {
      if (err.code === 'auth/too-many-requests') throw new Error('잠시 후 다시 시도해 주세요');
      if (err.code === 'auth/network-request-failed') throw new Error('네트워크 연결을 확인해 주세요');
      // 그 외(계정 없음/비밀번호 틀림 등)는 에러 코드로 단정하지 않고,
      // 아래에서 Firestore 문서 조회 결과로 실제 상황을 판별한다.
    }

    let userDoc;
    try {
      userDoc = await getDocOnce('users', safeId);
    } catch (readErr) {
      if (readErr.code === 'permission-denied') {
        // 계정은 존재하지만(문서가 있었다면 resource==null 규칙에 안 걸림) 인증이
        // 안 되어 읽기가 거부된 것 — 곧 비밀번호가 틀렸다는 뜻
        throw new Error('비밀번호가 틀렸습니다');
      }
      throw readErr;
    }
    if (!userDoc) throw new Error('아이디가 존재하지 않습니다');

    await setDoc('emailIndex', email.toLowerCase(), { safeId }); // 로그인마다 색인 최신화
    applyUserDoc(safeId, userDoc);
    return currentUser;
  } finally {
    manualLoginInProgress = false;
  }
}

async function doLogout() {
  try {
    await authInstance.signOut();
  } catch (e) {
    /* 무시 */
  }
  DbEngine.stopAll();
  currentUser = null;
  companies = [];
  activeCoIdx = 0;
}

/** 회사 목록/현재 선택 회사를 Firestore에 저장합니다. */
async function saveUserMeta() {
  if (!currentUser) return;
  await updateDoc('users', currentUser.safeId, { companies, activeCoIdx });
}

/** 현재 로그인 상태를 읽기 전용으로 반환합니다 (다른 모듈에서 참조용). */
function getAuthState() {
  return { currentUser, companies, activeCoIdx };
}

window.initAuth = initAuth;
window.onAuthReady = onAuthReady;
window.computeSafeId = computeSafeId;
window.authEmailOf = authEmailOf;
window.curCompanyId = curCompanyId;
window.doRegister = doRegister;
window.doLogin = doLogin;
window.doLogout = doLogout;
window.saveUserMeta = saveUserMeta;
window.getAuthState = getAuthState;
