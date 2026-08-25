/**
 * routeCache.json에 이미 저장된 과거 결과들은 fastTransfer.js(빠른 환승 칸·문 정보)가
 * 생기기 전에 캐시된 것들이라 boardingCar/boardingDoor가 없다. 실사용자가 그 캐시를 그대로
 * 받으면 새로 배포된 기능이 있어도 오래된 캐시 때문에 안 보이는데, 캐시는 재배포 전까지 계속
 * 유지되므로 자연스럽게 새로고침되길 기다리는 대신 한 번에 소급 적용한다.
 *
 * 실행: node scripts/refreshCacheBoardingSpots.js
 */
const fs = require("fs");
const path = require("path");
const { enrichSegmentsWithBoardingSpots } = require("../fastTransfer");

const CACHE_PATH = path.join(__dirname, "..", "data", "routeCache.json");

function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  let touched = 0;
  let checked = 0;

  for (const key of Object.keys(cache)) {
    const route = cache[key];
    if (!route?.available || !Array.isArray(route.segments) || route.segments.length < 2) continue;
    checked++;

    const before = JSON.stringify(route.segments);
    enrichSegmentsWithBoardingSpots(route.segments);
    if (JSON.stringify(route.segments) !== before) touched++;
  }

  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
  console.log(`환승 2개 이상인 캐시 ${checked}개 중 ${touched}개에 빠른 환승 정보를 새로 채웠습니다.`);
}

main();
