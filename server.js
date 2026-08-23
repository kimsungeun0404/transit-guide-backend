/**
 * transit-guide-backend
 * ---------------------
 * 외국인 대중교통 안내 앱의 "역 좌표 조회 / 최단거리 역 계산" 백엔드.
 *
 * 설계 원칙:
 * 1) 역 좌표는 자주 바뀌지 않으므로(분기별 갱신), 매 요청마다 정부 API를 호출하지 않고
 *    서버 메모리에 캐싱해두고 그걸로 응답한다.
 * 2) 기본값은 로컬 CSV(data/stations.csv) — 이건 확실하게 항상 작동한다.
 * 3) .env에 SEOUL_API_KEY / SEOUL_SERVICE_NAME이 채워져 있으면, 시작 시 + 주기적으로
 *    서울 열린데이터광장 API를 호출해서 캐시를 갱신 시도한다. 실패하면 조용히 CSV로 되돌아간다.
 * 4) 프론트엔드(React Native 앱)는 이 서버의 /api/stations/nearest 만 호출하면 된다.
 *    실제 정부 API 주소나 인증키는 프론트엔드에 절대 노출되지 않는다.
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const CSV_PATH = path.join(__dirname, "data", "stations.csv");
const ROUTE_CACHE_PATH = path.join(__dirname, "data", "routeCache.json");
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24시간마다 갱신 시도 (분기별 갱신 데이터라 이 정도면 충분)

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

// ---------------------------------------------------------------------------
// 메모리 캐시
// ---------------------------------------------------------------------------
let stationsCache = [];
let lastUpdated = null;
let lastSource = "none"; // "csv" | "api"

// ---------------------------------------------------------------------------
// CSV 로더 (항상 성공해야 하는 기본 경로)
// ---------------------------------------------------------------------------
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
      return {
        name: row.name,
        line: row.line,
        lat: parseFloat(row.lat),
        lng: parseFloat(row.lng),
      };
    })
    .filter((s) => s.name && Number.isFinite(s.lat) && Number.isFinite(s.lng));
}

// ---------------------------------------------------------------------------
// (선택) 서울 열린데이터광장 Open API에서 갱신 시도
// URL 패턴: http://openapi.seoul.go.kr:8088/{인증키}/{파일타입}/{서비스명}/{시작}/{끝}/
// ⚠️ SEOUL_SERVICE_NAME은 실제 데이터셋 상세 페이지에서 정확한 값을 확인해서 .env에 넣어야 합니다.
//    확인 안 된 값으로 호출하면 아래 fetch는 에러를 던지고, 자동으로 CSV로 대체됩니다.
// ---------------------------------------------------------------------------
async function refreshFromOpenAPI() {
  const key = process.env.SEOUL_API_KEY;
  const serviceName = process.env.SEOUL_SERVICE_NAME;
  if (!key || !serviceName) {
    console.log("[stations] SEOUL_API_KEY/SEOUL_SERVICE_NAME 미설정 — CSV만 사용합니다.");
    return false;
  }

  try {
    const url = `http://openapi.seoul.go.kr:8088/${key}/json/${serviceName}/1/1000/`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // ⚠️ 실제 응답 구조(필드명)는 서비스명에 따라 다릅니다.
    // 아래는 "역명/위도/경도 필드가 있는 배열"이라는 일반적인 가정이며,
    // 실제 데이터셋 문서를 보고 필드명을 맞게 수정해야 합니다.
    const rows = data[serviceName]?.row;
    if (!Array.isArray(rows) || rows.length === 0) throw new Error("응답에 유효한 row 없음");

    const parsed = rows
      .map((r) => ({
        name: r.STATION_NM || r.SBWY_STNS_NM || r.name,
        line: r.LINE_NUM || r.SBWY_ROUT_LN || r.line,
        lat: parseFloat(r.LAT || r.YCOORD || r.lat),
        lng: parseFloat(r.LOT || r.XCOORD || r.lng),
      }))
      .filter((s) => s.name && Number.isFinite(s.lat) && Number.isFinite(s.lng));

    if (parsed.length === 0) throw new Error("파싱 결과 0건");

    stationsCache = parsed;
    lastUpdated = new Date().toISOString();
    lastSource = "api";
    console.log(`[stations] API 갱신 성공 — ${parsed.length}개 역 로드`);
    return true;
  } catch (err) {
    console.warn("[stations] API 갱신 실패, CSV 유지:", err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 초기화: CSV 먼저 로드(항상 성공) → 가능하면 API로 덮어쓰기 시도
// ---------------------------------------------------------------------------
function initStations() {
  stationsCache = loadStationsFromCSV();
  lastUpdated = new Date().toISOString();
  lastSource = "csv";
  console.log(`[stations] CSV 로드 완료 — ${stationsCache.length}개 역`);

  refreshFromOpenAPI(); // 실패해도 위에서 이미 CSV로 채워진 상태라 무해함
  setInterval(refreshFromOpenAPI, REFRESH_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// 거리 계산 (하버사인)
// ---------------------------------------------------------------------------
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// 서울시 대중교통환승경로 조회 서비스 연동 (공공데이터포털, data.go.kr)
// 출발/도착 좌표만 주면 실제 지하철/버스 노선·환승·소요시간을 계산해준다.
// ODsay(무료 체험 6개월 한정)를 완전히 대체한다 — 이건 정부/서울시가 직접 운영하는
// 상시 무료 오픈API로, 개발계정 기준 하루 1,000회(ODsay 30회의 30배 이상) 사용 가능하다.
// .env에 SEOUL_TRANSIT_API_KEY가 없으면 이 기능은 조용히 "unavailable"을 반환하고,
// 프론트엔드는 그 경우 발매기 위치처럼 답사 기반 안내로 대체한다.
// 키 발급: https://www.data.go.kr → "서울특별시_대중교통환승경로 조회 서비스" 검색 →
// 활용신청(4개 오퍼레이션 전부) → 승인 후 발급되는 인증키(Encoding) 그대로 사용.
//
// 실측으로 확인한 것 (문서에 없는 내용):
// - 오퍼레이션 이름(getPathInfoByBusNSubList 등)과 실제 호출 경로가 다르다 —
//   "List" 접미사를 뺀 getPathInfoBySubway / getPathInfoByBus / getPathInfoByBusNSub가
//   진짜 엔드포인트다. 잘못된 이름으로 호출하면 "등록되지 않은 서비스키"라는, 원인을
//   전혀 알 수 없는 오해의 소지가 큰 에러가 난다.
// - 이름은 "버스지하철환승"(getPathInfoByBusNSub)이지만, 실제로는 지하철이 명백히 더
//   나은 구간에서도 버스만 있는 경로만 줄 때가 있다(예: 서울역→강남역 실측 시 19개 결과
//   전부 버스만 있었음). 그래서 이것 하나만 믿지 않고, 지하철 전용/버스 전용/환승 3개를
//   전부 조회해서 그중 총 소요시간이 가장 짧은 걸 우리가 직접 골라 ODsay가 하던
//   "가장 좋은 경로 하나 고르기"를 대신한다.
// - 구간별 소요시간을 따로 안 주고 경로 전체 합계(time)만 준다 — 지하철 구간은
//   railLinkList 길이(대략 정거장 수)로, 버스 구간은 균등하게 비례 배분해서 추정한다.
// - ODsay가 주던 지하철 추천 승차 칸(boardingCar)·추천 승하차 출구 번호(exitNo)에
//   해당하는 정보가 없다 — 프론트엔드는 이미 이 필드들이 없을 때를 조건부로 처리하므로
//   화면이 깨지지는 않고, 그 부가 안내만 빠진다.
// ---------------------------------------------------------------------------
const SEOUL_TRANSIT_BASE = "http://ws.bus.go.kr/api/rest/pathinfo";

async function callSeoulTransitApi(operation, slat, slng, dlat, dlng) {
  const apiKey = process.env.SEOUL_TRANSIT_API_KEY;
  const url =
    `${SEOUL_TRANSIT_BASE}/${operation}?serviceKey=${apiKey}` +
    `&startX=${slng}&startY=${slat}&endX=${dlng}&endY=${dlat}&resultType=json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    if (data?.msgHeader?.headerCd !== "0") return [];
    return data?.msgBody?.itemList || [];
  } catch (err) {
    console.warn(`[route] 서울시 API(${operation}) 호출 실패:`, err.message);
    return [];
  }
}

function normalizeSeoulPathList(pathList, totalTimeMin) {
  // railLinkList 길이(지하철 구간 수)나 1(버스 구간)을 가중치로 써서 전체 소요시간을
  // 구간별로 비례 배분한다 — 이 API는 ODsay와 달리 구간별 소요시간을 따로 안 준다.
  const weights = pathList.map((p) => (p.railLinkList ? p.railLinkList.length : 1));
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  const stripStationSuffix = (name) => (name || "").replace(/역$/, "");

  return pathList.map((p, idx) => {
    const minutes = Math.max(1, Math.round((totalTimeMin * weights[idx]) / totalWeight));
    if (p.railLinkList) {
      return {
        mode: "subway",
        line: p.routeNm,
        startStation: stripStationSuffix(p.fname),
        endStation: stripStationSuffix(p.tname),
        stationCount: p.railLinkList.length,
        minutes,
      };
    }
    return {
      mode: "bus",
      busNo: p.routeNm,
      startStation: p.fname,
      endStation: p.tname,
      minutes,
      startLat: parseFloat(p.fy),
      startLng: parseFloat(p.fx),
      endLat: parseFloat(p.ty),
      endLng: parseFloat(p.tx),
    };
  });
}

async function fetchTransitRoute(slat, slng, dlat, dlng, preferSubway = false, debug = false) {
  const apiKey = process.env.SEOUL_TRANSIT_API_KEY;
  if (!apiKey) return { available: false, reason: "SEOUL_TRANSIT_API_KEY 미설정" };

  // 출발지·도착지가 아주 가까우면(700m 이내) 대중교통을 탈 필요가 없다 — API 호출 자체를
  // 생략하고(할당량 절약) 도보 시간을 바로 계산해서 알려준다.
  const walkMeters = Math.round(haversineMeters(slat, slng, dlat, dlng));
  if (walkMeters < 700) {
    return { available: false, reason: "too_close", walkable: true, walkMeters, walkMinutes: Math.max(1, Math.round(walkMeters / 70)) };
  }

  try {
    const [subwayItems, busItems, mixedItems] = await Promise.all([
      callSeoulTransitApi("getPathInfoBySubway", slat, slng, dlat, dlng),
      callSeoulTransitApi("getPathInfoByBus", slat, slng, dlat, dlng),
      callSeoulTransitApi("getPathInfoByBusNSub", slat, slng, dlat, dlng),
    ]);

    const allItems = [...subwayItems, ...busItems, ...mixedItems];
    if (allItems.length === 0) {
      return { available: false, reason: "검색 결과 없음", reasonCode: "NO_ROUTE_FOUND" };
    }

    // 이 API의 버스 소요시간(item.time)은 서울 시내버스 기준 추정치라, 인천공항처럼 서울시
    // 경계 밖에서 출발하는 장거리 구간에서는 터무니없이 짧게(예: 50km를 16분) 나오는 경우가
    // 실측으로 확인됐다 — 그래서 "가장 빠른 경로"만 고르면 지하철 구간이 있어도 무시되고
    // 비현실적인 버스 경로가 뽑힌다. getPathInfoBySubway 전용 결과(subwayItems)는 실측상 거의
    // 항상 비어 있어서(김포공항 출발도 마찬가지) 그것만 보면 안 되고, getPathInfoByBusNSub가
    // 돌려주는 "혼합" 경로 중 지하철 구간을 하나라도 포함한 것까지 넓게 봐야 한다.
    const hasSubwayLeg = (item) => (item.pathList || []).some((leg) => leg.railLinkList);
    const subwayCapableItems = allItems.filter(hasSubwayLeg);
    const pool = preferSubway && subwayCapableItems.length ? subwayCapableItems : allItems;
    const best = pool.reduce((a, b) => (Number(a.time) <= Number(b.time) ? a : b));
    const totalTimeMin = Number(best.time) || 0;
    const segments = normalizeSeoulPathList(best.pathList, totalTimeMin);

    return {
      available: true,
      summary: { totalTimeMin, transfers: Math.max(0, segments.length - 1), fare: null },
      segments,
      source: "서울시 대중교통환승경로 조회 서비스",
      ...(debug
        ? {
            _debug: {
              subwayCount: subwayItems.length,
              busCount: busItems.length,
              mixedCount: mixedItems.length,
              subwayCapableCount: subwayCapableItems.length,
              subwayBestTime: subwayItems.length ? Math.min(...subwayItems.map((p) => Number(p.time))) : null,
              busBestTime: busItems.length ? Math.min(...busItems.map((p) => Number(p.time))) : null,
              mixedBestTime: mixedItems.length ? Math.min(...mixedItems.map((p) => Number(p.time))) : null,
              mixedHasSubwayLeg: mixedItems.some((p) => (p.pathList || []).some((leg) => leg.railLinkList)),
            },
          }
        : {}),
    };
  } catch (err) {
    console.warn("[route] 서울시 대중교통 API 호출 실패:", err.message);
    return { available: false, reason: "조회 실패", reasonCode: "LOOKUP_FAILED" };
  }
}

// ---------------------------------------------------------------------------
// (선택) 카카오 로컬 검색 API 연동 — 주소/장소 이름으로 좌표 검색(지오코딩)
// 숙소는 관광지와 달리 사용자마다 다른 곳이라 미리 좌표를 등록해둘 수 없다. 검색어(주소 또는
// "OO호텔" 같은 장소명)를 받아 카카오의 "키워드로 장소 검색" API로 후보 목록(이름/주소/좌표)을 준다.
// .env에 KAKAO_REST_API_KEY가 없으면 { available: false }만 반환하고, 앱은 이 경우
// "현재 위치를 숙소로 저장" 방식으로 대체 안내한다.
// 키 발급: https://developers.kakao.com (회원가입 → 애플리케이션 추가 → REST API 키, 무료)
// ---------------------------------------------------------------------------
// 카카오 "키워드로 장소 검색"은 가게이름/카테고리 위주라, 해외 예약 사이트에서 그대로 복사해온
// 정식 영문 주소("3-6, Hangang-daero 92-gil, Yongsan-gu, Seoul")를 넣으면 못 찾는 경우가 많다.
// 이럴 때 OpenStreetMap(Nominatim)의 주소 검색으로 좌표만이라도 찾아본다 — 무료, 키 불필요.
// 단, 실측 결과 한글 텍스트 검색은 Nominatim에서 엉뚱한 결과가 나올 수 있어(예: "경복궁"→검색 실패,
// 무관한 지명 오매칭) 영문(비한글) 주소일 때만 이 폴백을 쓴다.
function isNonKorean(text) {
  return !/[가-힣]/.test(text);
}

// 예약 사이트의 "지도에서 보기"를 누르면 대부분 구글 지도로 연결되고, 구글 지도 앱의 "공유"
// 버튼으로 정확한 GPS 좌표가 담긴 링크를 얻을 수 있다. 이 링크를 그대로 검색창에 붙여넣으면
// 카카오/OSM 텍스트 검색을 거칠 필요 없이 좌표를 URL에서 직접 뽑아낼 수 있어 훨씬 정확하고,
// 카카오 API 상태와도 무관하게 항상 동작한다. 단축 링크(maps.app.goo.gl 등)는 좌표가 URL에
// 없으므로 리다이렉트를 따라가 실제 주소를 얻은 뒤 같은 방식으로 좌표를 뽑는다.
async function resolveGoogleMapsLink(text) {
  const urlMatch = text.match(/https?:\/\/(?:www\.)?(?:[a-z]+\.)?google\.[a-z.]+\/maps\S*|https?:\/\/maps\.app\.goo\.gl\/\S+|https?:\/\/goo\.gl\/maps\/\S+/i);
  if (!urlMatch) return null;

  let url = urlMatch[0];
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(6000) });
    url = res.url || url;
  } catch (err) {
    console.warn("[geocode] 구글 지도 링크 해석 실패:", err.message);
    return null;
  }

  const coordMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/) || url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (!coordMatch) return null;

  const placeMatch = url.match(/\/place\/([^/@]+)/);
  const name = placeMatch ? decodeURIComponent(placeMatch[1].replace(/\+/g, " ")) : null;

  return { lat: parseFloat(coordMatch[1]), lng: parseFloat(coordMatch[2]), name };
}

// 구글 지도에서 위치를 길게 눌러 "좌표 복사"를 하면 URL이 아니라 "37.5461, 126.9730" 같은
// 순수 위도/경도 텍스트만 클립보드에 담긴다. 이미 정확한 좌표이므로 검색을 거칠 필요가 전혀
// 없다 — 오인식 방지를 위해 대략 한국 영역(위도 33~39, 경도 124~132)인지만 확인한다.
function parseRawCoordinates(text) {
  // 기기/지역 설정에 따라 도(°) 기호, N/E 표기, 특수 공백 문자가 섞여 나올 수 있어 먼저 정리한다.
  const normalized = text
    .replace(/[   ]/g, " ")
    .replace(/[°º]/g, "")
    .replace(/[NSEW]/gi, "")
    .trim();
  const m = normalized.match(/^(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (lat < 33 || lat > 39 || lng < 124 || lng > 132) return null;
  return { lat, lng };
}

async function geocodeOnceOSM(text) {
  const url =
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(text)}` +
    `&format=jsonv2&countrycodes=kr&limit=1`;
  try {
    const res = await fetch(url, {
      headers: {
        // Nominatim 이용 정책: 식별 가능한 User-Agent 필수
        "User-Agent": "SeoulTransitGuideApp/1.0 (+https://github.com/kimsungeun0404/transit-guide-app)",
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const item = data[0];
    if (!item) return null;
    return { lat: parseFloat(item.lat), lng: parseFloat(item.lon), displayName: item.display_name };
  } catch (err) {
    console.warn("[geocode] OSM 주소 검색 실패:", err.message);
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "yongsangu"→"yongsan-gu", "huamro"→"huam-ro"처럼 로마자 주소에서 구/동/로/길/대로 접미사가
// 하이픈 없이 붙어 나오면 Nominatim이 매칭에 실패한다(실측 확인: 대소문자·단어 순서는 무관하고
// 하이픈 유무만으로 성공/실패가 갈림). 단, "Myeongdong"처럼 이미 굳어진 지명에 이 규칙을 무조건
// 적용하면 "Myeong-dong"으로 잘못 쪼갤 수 있으므로, 원문이 이미 성공한 경우엔 절대 쓰지 않고
// 다른 시도가 전부 실패했을 때 마지막 안전망으로만 사용한다.
function insertAddressHyphens(text) {
  return text.replace(/([a-zA-Z]+?)(daero|dong|gil|gun|gu|ro)\b/gi, (match, stem, suf) => {
    if (!stem || stem.endsWith("-")) return match;
    return `${stem}-${suf}`;
  });
}

// 국가명("South Korea")이나 우편번호("04334")처럼 예약 사이트 주소 끝에 붙는 조각이 있으면
// Nominatim이 매칭에 실패하는 경우가 많다(실측 확인: "...Yongsan-gu, Seoul"까지는 성공하지만
// "...Yongsan-gu, Seoul, South Korea, 04334"는 실패). 전체 문자열이 실패하면 쉼표 단위로
// 뒤에서부터 한 조각씩 잘라내며 다시 시도한다 — 어떤 꼬리 부분이 문제인지 미리 알 필요가 없다.
async function searchAddressOSM(query) {
  const segments = query.split(",").map((s) => s.trim()).filter(Boolean);
  const maxDrops = Math.min(3, segments.length - 1);
  for (let drop = 0; drop <= maxDrops; drop++) {
    const attempt = segments.slice(0, segments.length - drop).join(", ");
    if (!attempt) break;
    const result = await geocodeOnceOSM(attempt);
    if (result) return result;
    if (drop < maxDrops) await sleep(300); // Nominatim 이용 정책: 초당 1회 이하
  }

  const hyphenated = insertAddressHyphens(query);
  if (hyphenated !== query) {
    await sleep(300);
    const result = await geocodeOnceOSM(hyphenated);
    if (result) return result;
  }

  return null;
}

// "현재 위치를 숙소로 저장" 흐름은 좌표만 있고 사람이 읽을 이름이 없어 카드에 "내 숙소" 같은
// 의미 없는 문구만 뜬다. Nominatim의 reverse 엔드포인트로 좌표를 실제 주소 문자열로 바꿔준다.
async function reverseGeocodeOSM(lat, lng) {
  const url =
    `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}` +
    `&format=jsonv2&zoom=18&addressdetails=0`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "SeoulTransitGuideApp/1.0 (+https://github.com/kimsungeun0404/transit-guide-app)",
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.display_name || null;
  } catch (err) {
    console.warn("[geocode] OSM 역지오코딩 실패:", err.message);
    return null;
  }
}

async function searchPlaces(query) {
  const rawCoords = parseRawCoordinates(query);
  if (rawCoords) {
    return {
      available: true,
      results: [{ name: query, address: null, lat: rawCoords.lat, lng: rawCoords.lng, category: null }],
      source: "좌표 직접 입력",
    };
  }

  const mapsMatch = await resolveGoogleMapsLink(query);
  if (mapsMatch) {
    return {
      available: true,
      results: [{ name: mapsMatch.name || query, address: null, lat: mapsMatch.lat, lng: mapsMatch.lng, category: null }],
      source: "구글 지도 링크",
    };
  }

  const apiKey = process.env.KAKAO_REST_API_KEY;
  if (!apiKey) return { available: false, reason: "KAKAO_REST_API_KEY 미설정" };

  const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&size=10`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `KakaoAK ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.warn("[geocode] 카카오 API 오류:", res.status, errBody);
      return { available: false, reason: `카카오 API 오류 (${res.status})` };
    }
    const data = await res.json();
    const results = (data.documents || []).map((d) => ({
      name: d.place_name,
      address: d.road_address_name || d.address_name,
      lat: parseFloat(d.y),
      lng: parseFloat(d.x),
      category: d.category_group_name || (d.category_name || "").split(" > ").pop() || null,
    }));

    if (results.length === 0 && isNonKorean(query)) {
      const osmMatch = await searchAddressOSM(query);
      if (osmMatch) {
        return {
          available: true,
          results: [{ name: query, address: osmMatch.displayName, lat: osmMatch.lat, lng: osmMatch.lng, category: null }],
          source: "OpenStreetMap 주소 검색",
        };
      }
    }

    return { available: true, results, source: "카카오 로컬 검색" };
  } catch (err) {
    console.warn("[geocode] 카카오 호출 실패:", err.message);
    return { available: false, reason: "조회 실패" };
  }
}

// ---------------------------------------------------------------------------
// 라우트
// ---------------------------------------------------------------------------

// 헬스체크 + 캐시 상태 확인용
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    stationCount: stationsCache.length,
    lastUpdated,
    source: lastSource,
  });
});

// 전체 역 목록
app.get("/api/stations", (req, res) => {
  res.json({ stations: stationsCache, count: stationsCache.length, source: lastSource });
});

// 최단거리 역 계산 — 앱이 실제로 호출할 핵심 엔드포인트
// GET /api/stations/nearest?lat=37.5636&lng=126.9834&limit=1
app.get("/api/stations/nearest", (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const limit = Math.min(parseInt(req.query.limit) || 1, 20);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: "lat, lng 쿼리 파라미터가 필요합니다 (숫자)" });
  }
  if (lat < 33 || lat > 39 || lng < 124 || lng > 132) {
    return res.status(400).json({ error: "한국 영역을 벗어난 좌표입니다" });
  }
  if (stationsCache.length === 0) {
    return res.status(503).json({ error: "역 데이터가 아직 준비되지 않았습니다" });
  }

  const ranked = stationsCache
    .map((s) => ({ ...s, distance_m: Math.round(haversineMeters(lat, lng, s.lat, s.lng)) }))
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, limit);

  res.json({ query: { lat, lng }, results: ranked, source: lastSource });
});

// 자주 조회되는 "출발역 → 목적지" 조합은 미리 조회해서 backend/data/routeCache.json에
// 저장해두고 여기서 먼저 찾아본다 — 서울시 API 할당량(하루 1,000회)에 여유가 있긴 하지만
// 응답 속도 자체도 캐시가 훨씬 빠르다. scripts/seedRouteCache.js가 매일 이 캐시를 조금씩
// 채워나간다 — 자세한 내용은 그 파일 참고. 캐시에 없는 조합만 그때 실시간으로 호출한다.
//
// 이 사전 시딩은 "역↔관광지/공항"처럼 고정된 조합만 커버한다 — 숙소는 사용자가 주소로
// 직접 검색해서 나오는 임의의 좌표라 애초에 미리 목록화할 수가 없다. 그래서 실시간 조회가
// 성공하면 그 결과도 캐시에 실시간으로 추가해서, 같은 지역(가까운 숙소들)의 다음 조회부터는
// 캐시가 먹도록 한다 — 좌표를 소수점 4자리(~11m)로 반올림해 "사실상 같은 건물"끼리는
// 캐시를 공유하게 한다. Render 무료 플랜은 디스크가 재배포/재시작 시 초기화될 수 있어
// 파일 저장이 영구적이진 않지만, 인스턴스가 떠 있는 동안은(그리고 재시작 전까지는 파일에도)
// 계속 누적되므로 완전히 헛되지는 않는다.
let routeCache = {};
try {
  routeCache = JSON.parse(fs.readFileSync(ROUTE_CACHE_PATH, "utf8"));
} catch (err) {
  console.warn("[route] 경로 캐시 로드 실패, 빈 캐시로 시작:", err.message);
}

function routeCacheKey(slat, slng, dlat, dlng, preferSubway = false) {
  const round = (n) => Number(n).toFixed(4);
  const base = `${round(slat)},${round(slng)},${round(dlat)},${round(dlng)}`;
  return preferSubway ? `${base};subway` : base;
}

function rememberRoute(cacheKey, route) {
  routeCache[cacheKey] = route;
  try {
    fs.writeFileSync(ROUTE_CACHE_PATH, JSON.stringify(routeCache));
  } catch (err) {
    // 디스크에 못 써도(읽기 전용 배포 등) 메모리 캐시는 이번 인스턴스가 떠 있는 동안 계속 유효하다.
    console.warn("[route] 캐시 파일 저장 실패(메모리 캐시는 계속 사용됨):", err.message);
  }
}

// 대중교통 경로 검색 — 서울시 대중교통환승경로 API 연동 (SEOUL_TRANSIT_API_KEY 미설정 시 { available: false } 반환)
// GET /api/route/transit?slat=&slng=&dlat=&dlng=&preferSubway=1
app.get("/api/route/transit", async (req, res) => {
  const slat = parseFloat(req.query.slat);
  const slng = parseFloat(req.query.slng);
  const dlat = parseFloat(req.query.dlat);
  const dlng = parseFloat(req.query.dlng);
  // 공항처럼 서울시 경계 밖에서 출발하는 화면(AccommodationScreen)만 이 플래그를 보낸다.
  const preferSubway = req.query.preferSubway === "1";
  const debug = req.query.debug === "1";

  if (![slat, slng, dlat, dlng].every(Number.isFinite)) {
    return res.status(400).json({ error: "slat, slng, dlat, dlng 쿼리 파라미터가 필요합니다 (숫자)" });
  }

  if (debug) {
    const route = await fetchTransitRoute(slat, slng, dlat, dlng, preferSubway, true);
    return res.json(route);
  }

  const cacheKey = routeCacheKey(slat, slng, dlat, dlng, preferSubway);
  const cached = routeCache[cacheKey];
  if (cached) {
    return res.json(cached);
  }

  const route = await fetchTransitRoute(slat, slng, dlat, dlng, preferSubway);
  // 성공한 결과만 캐시에 넣는다 — 할당량 초과 등 일시적 실패를 "경로 없음"으로 굳혀버리면 안 된다.
  if (route.available) rememberRoute(cacheKey, route);
  res.json(route);
});

// 주소/장소 이름 검색(지오코딩) — 카카오 로컬 API 연동 (KAKAO_REST_API_KEY 미설정 시 { available: false } 반환)
// GET /api/geocode/search?query=명동 게스트하우스
app.get("/api/geocode/search", async (req, res) => {
  const query = (req.query.query || "").trim();
  if (!query) return res.status(400).json({ error: "query 쿼리 파라미터가 필요합니다" });

  const result = await searchPlaces(query);
  res.json(result);
});

app.get("/api/geocode/reverse", async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: "lat, lng 쿼리 파라미터가 필요합니다" });
  }
  const address = await reverseGeocodeOSM(lat, lng);
  res.json(address ? { available: true, address } : { available: false });
});

// 관리자용: 즉시 재갱신 트리거 (필요할 때만 사용)
app.post("/api/stations/refresh", async (req, res) => {
  const ok = await refreshFromOpenAPI();
  res.json({ refreshed: ok, source: lastSource, stationCount: stationsCache.length });
});

initStations();

app.listen(PORT, () => {
  console.log(`[server] transit-guide-backend listening on http://localhost:${PORT}`);
});
