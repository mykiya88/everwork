/**
 * EwGate.gs — everWORK GAS 입구 잠금 (쇼핑몰 점검앱 「GAS 비밀 키」와 같은 방식)
 *
 * 워커(evergrow-dash.pages.dev)가 GAS 를 부를 때마다 k=비밀키 를 붙입니다.
 * 이 파일은 키가 없는 everWORK 요청(api=…)을 거절합니다.
 * GAS 주소를 알아도 직접 불러서는 아무것도 받을 수 없게 됩니다.
 *
 * 건드리지 않는 것
 *  · action=… 요청 (26년 쇼핑몰 점검앱 등 예전 앱) — 26년 업무가 끝나면 함께 막을 예정
 *  · 주소만 연 경우(예전 HTML 대시보드) — 원래 있던 이메일 허용 목록이 그대로 지킵니다
 *  · 이 프로젝트 안에서 도는 트리거·텔레그램 발송 — 웹 요청이 아니라 상관없습니다
 *
 * ── 켜는 순서 (끊김 없이) ──
 *  1. 이 파일을 사업실적 프로젝트에 추가하고, doGet·doPost 맨 앞에 한 줄을 넣습니다 (안내 문서 참고)
 *  2. 편집기에서 ew_보안키_만들기() 실행 → 실행 로그에 나온 키를 복사
 *     (아직 잠그지 않습니다. 키만 만듭니다)
 *  3. 배포 관리 → 수정 → 새 버전 → 배포
 *  4. Cloudflare Pages(evergrow-dash) → 설정 → 환경 변수 → GAS_KEY (비밀) 에 붙여넣기 → 재배포
 *  5. https://evergrow-dash.pages.dev/api/d1_check 에서 GAS키설정: true 확인
 *  6. 편집기에서 ew_보안키_켜기() 실행 — 이때부터 키 없는 요청을 거절합니다
 *  문제가 생기면 ew_보안키_끄기() 한 번이면 예전 상태로 돌아갑니다(재배포 필요 없음).
 */

var EW_KEY_PROP  = 'EW_GAS_KEY';
var EW_GATE_PROP = 'EW_GATE';

/** doGet·doPost 맨 앞에서 부릅니다. 통과면 null, 거절이면 응답을 돌려줍니다. */
function ew_gate_(e) {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(EW_GATE_PROP) !== 'on') return null;

  var p = (e && e.parameter) || {};
  var isEw = !!p.api;
  if (!isEw && e && e.postData && e.postData.contents) {
    try { var b = JSON.parse(e.postData.contents); isEw = !!(b && b.api); } catch (x) {}
  }
  if (!isEw) return null;                       // everWORK 요청이 아니면 손대지 않습니다

  var key = props.getProperty(EW_KEY_PROP) || '';
  if (key && String(p.k || '') === key) return null;

  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'forbidden' }))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 새 키를 만들어 로그에 보여줍니다. 잠금은 켜지 않습니다. */
function ew_보안키_만들기() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  var bytes = Utilities.getUuid() + Utilities.getUuid() + new Date().getTime();
  var dig = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  var key = '';
  for (var i = 0; i < 32; i++) key += chars.charAt((dig[i] + 256) % chars.length);
  PropertiesService.getScriptProperties().setProperty(EW_KEY_PROP, key);
  Logger.log('새 키: ' + key);
  Logger.log('→ Cloudflare Pages(evergrow-dash) 환경 변수 GAS_KEY 에 붙여넣고 재배포한 뒤 ew_보안키_켜기() 를 실행하세요.');
  Logger.log('   (이미 켜져 있었다면 지금부터 Pages 를 바꿀 때까지 everWORK 가 멈춥니다)');
}

function ew_보안키_켜기() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty(EW_KEY_PROP)) { Logger.log('키가 없습니다. ew_보안키_만들기() 를 먼저 실행하세요.'); return; }
  props.setProperty(EW_GATE_PROP, 'on');
  Logger.log('잠금을 켰습니다. 키 없는 everWORK 요청은 이제 거절됩니다.');
}

function ew_보안키_끄기() {
  PropertiesService.getScriptProperties().deleteProperty(EW_GATE_PROP);
  Logger.log('잠금을 껐습니다. 예전처럼 키 없이도 받습니다.');
}

function ew_보안키_상태() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty(EW_KEY_PROP) || '';
  Logger.log('키: ' + (key ? '있음 (' + key.slice(0, 4) + '…)' : '없음') +
             ' / 잠금: ' + (props.getProperty(EW_GATE_PROP) === 'on' ? '켜짐' : '꺼짐'));
}
