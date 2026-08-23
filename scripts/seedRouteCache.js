/**
 * 경로 캐시(routeCache.json)를 조금씩 채워나가는 스크립트.
 *
 * 서울시 대중교통환승경로 API는 하루 1,000회 한도라(이전 ODsay 30회보다 훨씬 넉넉하지만)
 * 인기 "출발역 → 목적지" 조합을 매번 실시간으로 부르는 것보다 캐시가 더 빠르고 안전하다.
 * 이 스크립트를 매일 실행하면, 아직 캐시에 없는 조합 중 우선순위가 높은 것부터
 * MAX_CALLS_PER_RUN개만 채우고 멈춘다 — 나머지 할당량은 실제 사용자 트래픽을 위해 남겨둔다.
 *
 * 실행: node scripts/seedRouteCache.js
 * (배포된 백엔드의 /api/route/transit을 그대로 호출해서 채우므로, API 연동 로직을 중복 구현하지 않는다.)
 */
const fs = require("fs");
const path = require("path");
const {
  ORIGIN_STATIONS,
  DESTINATIONS,
  EXTRA_ORIGINS_FOR_DESTINATION,
  PRIORITY_AIRPORT_ORIGINS,
  PRIORITY_AIRPORT_DESTINATIONS,
} = require("../data/routeCacheTargets");

const BACKEND_URL = process.env.BACKEND_URL || "https://transit-guide-backend.onrender.com";
const CACHE_PATH = path.join(__dirname, "..", "data", "routeCache.json");
const MAX_CALLS_PER_RUN = 20; // 하루 30회 중 20회만 쓰고, 나머지는 실제 사용자 트래픽용으로 남겨둔다

// server.js의 routeCacheKey()와 반드시 같은 반올림 자릿수를 써야 한다 — 다르면 이 스크립트가
// 채워둔 항목과 실시간 조회가 서로 다른 키로 어긋나서 캐시가 전혀 안 맞게 된다.
function routeCacheKey(slat, slng, dlat, dlng, preferSubway = false) {
  const round = (n) => Number(n).toFixed(4);
  const base = `${round(slat)},${round(slng)},${round(dlat)},${round(dlng)}`;
  return preferSubway ? `${base};subway` : base;
}

// 캐시에 저장할 가치가 있는 "확정된" 응답인지 판단 — 할당량 초과·네트워크 실패 같은
// 일시적 오류는 캐시하지 않는다(나중에 다시 시도해야 하므로).
function isCacheworthy(result) {
  if (result.available === true) return true;
  if (result.available === false && result.walkable === true) return true;
  return false;
}

async function main() {
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch (err) {
    console.warn("기존 캐시 로드 실패, 빈 캐시로 시작:", err.message);
  }

  // 갈 때(역 → 관광지)뿐 아니라 올 때(관광지 → 역, "숙소로 돌아가기"에서 역을 숙소 지역의
  // 대리 지점으로 사용)도 함께 채운다 — 왕복 다 캐싱해야 실제 사용 패턴을 커버한다.
  const pending = [];
  let totalPairs = 0;

  // "공항 → 숙소" 조합이 다른 목록보다 검색 빈도가 높다고 판단해서 최우선으로 채운다 —
  // pending 배열 맨 앞에 넣으면 MAX_CALLS_PER_RUN 한도 내에서 항상 먼저 처리된다.
  for (const dest of PRIORITY_AIRPORT_DESTINATIONS) {
    totalPairs += PRIORITY_AIRPORT_ORIGINS.length * 2;
    for (const origin of PRIORITY_AIRPORT_ORIGINS) {
      // 인천공항(제1/2터미널)은 서울시 API의 지하철 네트워크 밖이라 arexOrigin으로 AREX+환승
      // 2단계 계산을 시켜야 한다(server.js의 fetchIncheonAirportRoute 참고) — 그냥 preferSubway만
      // 주면 지하철 후보 자체가 없어서 여전히 버스만 나온다. 김포공항은 서울시 소속이라 정상
      // 조회되므로 preferSubway만으로 충분하다.
      const arexOrigin = origin.name.includes("인천공항") ? (origin.name.includes("제2터미널") ? "t2" : "t1") : null;
      const goKey = arexOrigin ? `arex-${arexOrigin};${routeCacheKey(origin.lat, origin.lng, dest.lat, dest.lng)}` : routeCacheKey(origin.lat, origin.lng, dest.lat, dest.lng, true);
      if (!cache[goKey]) pending.push({ key: goKey, origin, dest, preferSubway: true, arexOrigin, label: `${origin.name} → ${dest.name}` });

      const backKey = routeCacheKey(dest.lat, dest.lng, origin.lat, origin.lng, true);
      if (!cache[backKey]) pending.push({ key: backKey, origin: dest, dest: origin, preferSubway: true, label: `${dest.name} → ${origin.name}` });
    }
  }

  for (const dest of DESTINATIONS) {
    // N서울타워처럼 버스가 꼭 필요한 목적지는 범용 8개 역 외에, 실제 버스를 탈 수 있는
    // "관문역"들도 추가로 채운다 — 출발지 조합이 늘어나는 게 아니라 관문역 자체가 소수라 안전하다.
    const origins = [...ORIGIN_STATIONS, ...(EXTRA_ORIGINS_FOR_DESTINATION[dest.name] || [])];
    totalPairs += origins.length * 2;
    for (const origin of origins) {
      const goKey = routeCacheKey(origin.lat, origin.lng, dest.lat, dest.lng);
      if (!cache[goKey]) pending.push({ key: goKey, origin, dest, label: `${origin.name} → ${dest.name}` });

      const backKey = routeCacheKey(dest.lat, dest.lng, origin.lat, origin.lng);
      if (!cache[backKey]) pending.push({ key: backKey, origin: dest, dest: origin, label: `${dest.name} → ${origin.name}` });
    }
  }

  console.log(`전체 조합 ${totalPairs}개(왕복, 관문역 포함) 중 미완료 ${pending.length}개.`);

  let filled = 0;
  let skipped = 0;
  for (const { key, origin, dest, preferSubway, arexOrigin } of pending) {
    if (filled >= MAX_CALLS_PER_RUN) {
      console.log(`이번 실행 한도(${MAX_CALLS_PER_RUN}개) 도달, 여기서 멈춤.`);
      break;
    }

    const url =
      `${BACKEND_URL}/api/route/transit?slat=${origin.lat}&slng=${origin.lng}&dlat=${dest.lat}&dlng=${dest.lng}` +
      (preferSubway ? "&preferSubway=1" : "") +
      (arexOrigin ? `&arexOrigin=${arexOrigin}` : "");
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const data = await res.json();

      if (isCacheworthy(data)) {
        cache[key] = data;
        filled++;
        console.log(`✓ ${origin.name} → ${dest.name}: 캐시 저장 (${data.available ? "경로 있음" : "도보 가능"})`);
      } else {
        skipped++;
        console.log(`✗ ${origin.name} → ${dest.name}: 캐시 안 함 (${data.reason || "알 수 없음"})`);
        if (data.reason && data.reason.includes("한도")) {
          console.log("일일 호출 한도 초과로 보임 — 오늘은 여기서 중단.");
          break;
        }
      }
    } catch (err) {
      console.warn(`✗ ${origin.name} → ${dest.name}: 호출 실패 (${err.message})`);
      skipped++;
    }
  }

  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
  console.log(`완료: 이번 실행에서 ${filled}개 채움, ${skipped}개 건너뜀. 남은 미완료: ${pending.length - filled}개.`);
}

main();
