/**
 * 국토교통부 "철도역 빠른 환승 정보" 공식 데이터 — 환승역에서 몇 번째 칸, 몇 번 출입문 앞에서
 * 타면 환승 통로와 가장 가까운지 알려준다. 서울시 대중교통 API는 이 정보를 안 주기 때문에
 * (예전 ODsay의 boardingCar에 해당하는 게 없음) 별도 조회 없이 이 정적 데이터로 채운다.
 *
 * server.js(실시간 조회)와 scripts/refreshCacheBoardingSpots.js(이미 캐시된 과거 결과를
 * 소급 보강)가 둘 다 이 로직을 써야 해서 별도 모듈로 뺐다.
 */
const fs = require("fs");
const path = require("path");

const CSV_PATH = path.join(__dirname, "data", "stations.csv");
const FAST_TRANSFER_PATH = path.join(__dirname, "data", "fastTransfer.json");

function loadStationsFromCSV() {
  const raw = fs.readFileSync(CSV_PATH, "utf-8").trim();
  const [headerLine, ...lines] = raw.split("\n");
  const headers = headerLine.split(",");
  return lines
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const cols = line.split(",");
      const row = {};
      headers.forEach((h, i) => (row[h.trim()] = cols[i]?.trim()));
      return { name: row.name, line: row.line, lat: parseFloat(row.lat), lng: parseFloat(row.lng) };
    })
    .filter((s) => s.name && Number.isFinite(s.lat) && Number.isFinite(s.lng));
}

let stationsCache = [];
try {
  stationsCache = loadStationsFromCSV();
} catch (err) {
  console.warn("[fastTransfer] stations.csv 로드 실패:", err.message);
}

let fastTransferRows = [];
try {
  fastTransferRows = JSON.parse(fs.readFileSync(FAST_TRANSFER_PATH, "utf8"));
} catch (err) {
  console.warn("[fastTransfer] 빠른 환승 데이터 로드 실패:", err.message);
}

// 이 데이터는 정부 원본 그대로라 노선 이름 표기가 서울시 API와 살짝 다르다("경의중앙선" ↔
// "경의중앙" 등, "신분당선"만 예외적으로 그대로 "선"이 붙어 있다) — 비교 전에 맞춰준다.
const FAST_TRANSFER_LINE_ALIASES = {
  경의중앙선: "경의중앙",
  수인분당선: "수인분당",
  경춘선: "경춘",
  우이신설선: "우이신설",
};
function normalizeLineForFastTransfer(line) {
  return FAST_TRANSFER_LINE_ALIASES[line] || line;
}

// 빠른 환승 데이터의 역 이름은 "대림(구로구청)"처럼 부기명이 괄호로 붙어 있거나, "불암산(당고개)"
// 처럼 개정된 이름과 옛 이름이 함께 붙어 있는 경우가 많다(실측 확인: "대림"으로 조회하면 서울시
// API 응답과는 안 맞아서 아예 매칭이 안 됨). 서울시 API·stations.csv는 둘 중 하나만 쓰므로,
// 괄호 앞부분/괄호 안쪽/"역" 유무를 전부 후보로 만들어 어느 쪽이든 매칭되게 한다.
function stationNameVariants(name) {
  if (!name) return [];
  const variants = new Set([name]);
  const parenMatch = name.match(/^(.*?)\((.*?)\)$/);
  if (parenMatch) {
    variants.add(parenMatch[1].trim());
    variants.add(parenMatch[2].trim());
  } else {
    variants.add(name.replace(/\(.*\)$/, "").trim());
  }
  for (const v of [...variants]) {
    variants.add(v.endsWith("역") ? v.slice(0, -1) : `${v}역`);
  }
  variants.delete("");
  return [...variants];
}

// 두 역 이름이 같은 역을 가리키는지(표기 변형을 감안해서) 판정한다.
function stationNamesMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const variantsB = new Set(stationNameVariants(b));
  return stationNameVariants(a).some((v) => variantsB.has(v));
}

// stations.csv의 역 이름은 대부분 "역" 접미사가 붙어 있지만("서울역"), 빠른 환승 데이터의
// 역/종착역 이름은 붙어 있을 때도("서울역") 없을 때도("방화") 있고 괄호 부기명이 붙기도 한다
// ("대림(구로구청)", "불암산(당고개)") — 표기 변형을 전부 후보로 만들어 찾는다.
function findStationCoords(name) {
  for (const variant of stationNameVariants(name)) {
    const hit = stationsCache.find((s) => s.name === variant);
    if (hit) return { lat: hit.lat, lng: hit.lng };
  }
  return null;
}

// 두 좌표를 지나는 방향 벡터를 기준으로, 후보들(각각 좌표 조회 가능한 역 이름) 중 그 방향과
// 가장 가까운 것을 고른다 — 실제 노선 순서 데이터가 없어서 좌표만으로 방향을 추정하는 공통
// 로직이다(종착역 판별에도, 환승 후 방향 판별에도 같은 방식을 쓴다). 방향이 애매하면(내적이
// 0 이하) null을 반환해서 틀린 칸을 알려주는 것보단 안내를 생략하게 한다.
function pickByDirection(fromCoord, toCoord, candidateNames) {
  if (!fromCoord || !toCoord) return null;
  const dirLat = toCoord.lat - fromCoord.lat;
  const dirLng = toCoord.lng - fromCoord.lng;
  let best = null;
  let bestScore = -Infinity;
  for (const name of candidateNames) {
    const c = findStationCoords(name);
    if (!c) continue;
    // (후보 - 시작점) 벡터가 (목표 - 시작점) 벡터와 같은 방향을 가리키는지 — 후보가 시작점보다
    // 훨씬 가깝든 훨씬 멀든(종착역처럼) 상관없이, 같은 쪽으로 가는지만 보는 게 핵심이다.
    const score = (c.lat - fromCoord.lat) * dirLat + (c.lng - fromCoord.lng) * dirLng;
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }
  return bestScore > 0 ? best : null;
}

// 이 노선을 startStation에서 endStation 방향으로 타고 있을 때, 빠른 환승 데이터의 종착역
// 후보 중 실제로 진행 중인 방향이 어느 쪽인지 좌표로 추정한다. 후보는 반드시 station(환승역)
// 기준으로 좁혀야 한다 — 같은 노선이라도 역마다 종착역 표기가 제각각이라(예: 4호선 남쪽 방향이
// 사당역 데이터에는 빈 문자열로, 다른 역 데이터에는 "남태령"으로 쓰여 있음) 노선 전체에서 후보를
// 모으면 이 역의 실제 데이터에는 없는 이름을 고를 수 있다. 일부 역은 한쪽 방향의 terminus
// 필드가 빈 문자열로 누락돼 있는데(정부 데이터 자체의 결측치, 실측 확인: 사당역 4호선→2호선
// 남쪽 방향), 이름 있는 후보들과 방향이 반대로 나오면 그 빈 문자열 쪽이 실제로는 나머지 한
// 방향을 가리키는 것으로 보고 시도해본다.
function inferTerminus(station, line, startStation, endStation) {
  const rowsHere = fastTransferRows.filter((r) => stationNamesMatch(r.station, station) && r.line === line);
  const candidates = [...new Set(rowsHere.filter((r) => r.terminus).map((r) => r.terminus))];
  const hasBlankTerminus = rowsHere.some((r) => !r.terminus);

  if (candidates.length === 0) return hasBlankTerminus ? "" : null;
  if (candidates.length === 1 && !hasBlankTerminus) return candidates[0];

  const startCoord = findStationCoords(startStation);
  const endCoord = findStationCoords(endStation);
  const picked = pickByDirection(startCoord, endCoord, candidates);
  if (picked) return picked;
  return hasBlankTerminus ? "" : null;
}

function findBoardingSpot(station, line, terminus, transferLine, hintStationNames = []) {
  const candidates = fastTransferRows.filter(
    (r) => stationNamesMatch(r.station, station) && r.line === line && r.terminus === terminus && r.transferLine === transferLine && r.car
  );
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { car: candidates[0].car, door: candidates[0].door };

  const uniqueSpots = new Set(candidates.map((c) => `${c.car},${c.door}`));
  if (uniqueSpots.size === 1) {
    const [car, door] = [...uniqueSpots][0].split(",");
    return { car, door };
  }

  // 방향에 따라 칸·문이 갈리는 경우 — 실제 경로에 나오는 역 이름과 afterStation이 일치하는 후보를 쓴다.
  const matched = candidates.find((c) => hintStationNames.some((name) => name && (name.includes(c.afterStation) || c.afterStation?.includes(name))));
  if (matched) return { car: matched.car, door: matched.door };

  // 문자열이 직접 안 겹치면(대부분의 경우 — afterStation은 환승 후 바로 다음 역이라 실제
  // 경로의 훨씬 나중 역과는 이름이 안 겹친다), 좌표로 방향을 추정한다: 환승역 기준으로 각
  // 후보의 afterStation이 실제 경로가 향하는 쪽(hintStationNames 중 가장 마지막 = 가장 멀리
  // 아는 지점)과 같은 방향인지 본다.
  const stationCoord = findStationCoords(station);
  const towardName = [...hintStationNames].reverse().find((name) => findStationCoords(name));
  const towardCoord = towardName ? findStationCoords(towardName) : null;
  if (stationCoord && towardCoord) {
    const byDirection = pickByDirection(
      stationCoord,
      towardCoord,
      candidates.map((c) => c.afterStation).filter(Boolean)
    );
    if (byDirection) {
      const spot = candidates.find((c) => c.afterStation === byDirection);
      if (spot) return { car: spot.car, door: spot.door };
    }
  }

  return null; // 방향을 확정 못 하면 틀린 칸을 알려주는 것보단 안내를 생략하는 게 낫다.
}

// 경로의 모든 지하철→지하철 환승 지점에 빠른 환승 칸·문 정보를 채워넣는다(버스가 낀 환승은
// 이 데이터에 없어서 건너뛴다). segments를 제자리에서 수정한다.
function enrichSegmentsWithBoardingSpots(segments) {
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = segments[i + 1];
    if (seg.mode !== "subway" || next.mode !== "subway") continue;

    const line = normalizeLineForFastTransfer(seg.line);
    const terminus = inferTerminus(seg.endStation, line, seg.startStation, seg.endStation);
    if (terminus === null) continue; // terminus는 빈 문자열("")도 유효한 결과라 null과 구분해야 한다.

    // next 하나만이 아니라 그 뒤로 남은 모든 구간의 역 이름까지 힌트로 준다 — 방향 추정에
    // "가장 멀리 아는 지점"을 쓰므로(pickByDirection), 목적지에 가까운 역일수록 더 정확하다.
    const hintStations = segments
      .slice(i + 1)
      .flatMap((s) => [s.startStation, s.endStation])
      .filter(Boolean);
    const spot = findBoardingSpot(seg.endStation, line, terminus, normalizeLineForFastTransfer(next.line), hintStations);
    if (spot) {
      seg.boardingCar = spot.car;
      seg.boardingDoor = spot.door;
    }
  }
}

module.exports = { enrichSegmentsWithBoardingSpots, findBoardingSpot, normalizeLineForFastTransfer };
