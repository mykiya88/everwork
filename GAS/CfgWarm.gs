/**
 * CfgWarm.gs — 달력 설정값 미리 채우기
 *
 * 공휴일·근무지역·주간계획·명단은 시트에서 관리하고
 * 워커가 D1 에 복사해 씁니다.
 *
 * 그런데 복사본이 없거나 오래되면, 그 순간 달력을 연 사람이
 * GAS 콜드스타트(약 7초)를 그대로 기다리게 됩니다.
 * 30분마다 미리 채워두면 사람이 기다릴 일이 없습니다.
 *
 * 2026-11 — 워커가 열쇠 없는 cfg_warm 을 거절하므로 열쇠를 붙여 부릅니다.
 *   열쇠 = EXP_TOKEN_SECRET 으로 「cfg_warm|오늘날짜(KST)」 를 서명한 값.
 *   비밀키 자체는 보내지 않고, 하루가 지나면 못 씁니다.
 *
 * ── 설치 ──
 * 1. 이 파일을 사업실적 프로젝트에 추가합니다(예전 것은 이 내용으로 바꿉니다).
 * 2. cfg_warmSetup() 을 한 번 실행합니다. (30분 트리거가 걸립니다)
 * 3. cfg_warm() 을 직접 한 번 실행해 지금 바로 채웁니다. 로그에 "ok":true 가 나오면 됩니다.
 */

var CFG_WARM_URL = 'https://evergrow-dash.pages.dev/api/cfg_warm';

function cfg_warm() {
  try {
    var url = CFG_WARM_URL + '?key=' + encodeURIComponent(ew_serverKey_('cfg_warm'));
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    Logger.log(res.getContentText());
  } catch (e) {
    Logger.log('예열 실패: ' + e);
  }
}

/** 워커와 서버끼리 주고받는 하루짜리 열쇠 */
function ew_serverKey_(label) {
  var secret = String(PropertiesService.getScriptProperties().getProperty('EXP_TOKEN_SECRET') || '').trim();
  var today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  var sig = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(label + '|' + today).getBytes(),
    Utilities.newBlob(secret).getBytes());
  return Utilities.base64EncodeWebSafe(sig).replace(/=+$/, '');
}

/** 30분마다 도는 트리거를 겁니다. 여러 번 실행해도 하나만 남습니다. */
function cfg_warmSetup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'cfg_warm') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('cfg_warm').timeBased().everyMinutes(30).create();
  Logger.log('30분 트리거를 걸었습니다.');
}
