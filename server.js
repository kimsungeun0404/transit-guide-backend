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
// (선택) ODsay 대중교통 길찾기 API 연동
// 출발/도착 좌표만 주면 실제 지하철/버스 노선·환승·소요시간을 계산해준다.
// .env에 ODSAY_API_KEY가 없으면 이 기능은 조용히 "unavailable"을 반환하고,
// 프론트엔드는 그 경우 발매기 위치처럼 답사 기반 안내로 대체한다.
// 키 발급: https://lab.odsay.com (회원가입 → 애플리케이션 등록, 개인 Basic 요금제 무료)
// ---------------------------------------------------------------------------
const ODSAY_LINE_PREFIX = /^(수도권|서울)\s*/;

// ODsay 실제 응답 주의사항(문서 예시와 다름, 실제 호출로 확인함):
// - lane은 객체가 아니라 배열이다 (sp.lane[0].name).
// - door 필드에 추천 탑승 칸이 들어있다 (예: "6-1"). 없으면 문자열 "null"이 오는데,
//   공항철도가 서울역에서 끝나는 구간처럼 일부 노선은 "0-0"으로 온다(둘 다 "추천 없음" 의미 —
//   실제 칸 번호는 항상 1 이상이라 "0-0"은 유효한 값일 수 없다).
// - 출발 구간엔 startExitNo(추천 승차 출구), 도착 구간엔 endExitNo(추천 하차 출구)가 붙는다.
// - info.subwayTransitCount는 "환승 횟수"가 아니라 "이용한 지하철 편수"다.
//   (1호선→3호선처럼 1번 환승해도 2가 찍힘) — 환승 횟수는 지하철 구간 수 - 1로 직접 계산해야 한다.
function normalizeOdsayPath(path) {
  // 지하철(1)과 버스(2) 구간을 실제 탑승 순서 그대로 하나의 배열로 만든다. 남산 방면처럼
  // 버스를 꼭 타야 하는 목적지도 있어서 버스 구간만 빼고 지하철만 보여주면 경로가 중간에
  // 끊긴 것처럼 보인다 — 실제로 조회된 전체 구간(지하철+버스)을 그대로 안내해야 한다.
  const segments = path.subPath
    .filter((sp) => sp.trafficType === 1 || sp.trafficType === 2)
    .map((sp) =>
      sp.trafficType === 1
        ? {
            mode: "subway",
            line: (sp.lane?.[0]?.name || "").replace(ODSAY_LINE_PREFIX, ""),
            direction: sp.way || null,
            startStation: sp.startName,
            endStation: sp.endName,
            stationCount: sp.stationCount,
            minutes: sp.sectionTime,
            boardingCar: sp.door && sp.door !== "null" && sp.door !== "0-0" ? sp.door : undefined,
            startExitNo: sp.startExitNo || undefined,
            startExitLat: sp.startExitY || undefined,
            startExitLng: sp.startExitX || undefined,
            endExitNo: sp.endExitNo || undefined,
            endExitLat: sp.endExitY || undefined,
            endExitLng: sp.endExitX || undefined,
          }
        : {
            mode: "bus",
            busNo: sp.lane?.[0]?.busNo || "",
            startStation: sp.startName,
            endStation: sp.endName,
            stationCount: sp.stationCount,
            minutes: sp.sectionTime,
            startLat: sp.startY,
            startLng: sp.startX,
            endLat: sp.endY,
            endLng: sp.endX,
          }
    );

  return {
    available: true,
    summary: {
      totalTimeMin: path.info.totalTime,
      transfers: Math.max(0, segments.length - 1),
      fare: path.info.payment,
    },
    segments,
    source: "ODsay 대중교통 길찾기",
  };
}

async function fetchTransitRoute(slat, slng, dlat, dlng) {
  const apiKey = process.env.ODSAY_API_KEY;
  if (!apiKey) return { available: false, reason: "ODSAY_API_KEY 미설정" };

  const url =
    `https://api.odsay.com/v1/api/searchPubTransPathT?SX=${slng}&SY=${slat}` +
    `&EX=${dlng}&EY=${dlat}&OPT=0&SearchPathType=0&apiKey=${encodeURIComponent(apiKey)}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();

    if (data.error) {
      // ODsay는 에러 응답 모양이 일정하지 않다 — 보통은 객체({code, msg})지만,
      // 일일 호출 한도 초과(429) 같은 일부 에러는 배열([{code, message}])로 온다.
      const errInfo = Array.isArray(data.error) ? data.error[0] : data.error;
      // -98: 출발지·도착지가 700m 이내 — 대중교통을 탈 필요가 없을 만큼 가깝다는 ODsay의 판단.
      // 이 경우 "경로 없음"이 아니라 "걸어가는 게 낫다"는 유용한 정보이므로 도보 시간을 계산해서 알려준다.
      if (errInfo?.code === "-98") {
        const walkMeters = Math.round(haversineMeters(slat, slng, dlat, dlng));
        return { available: false, reason: "too_close", walkable: true, walkMeters, walkMinutes: Math.max(1, Math.round(walkMeters / 70)) };
      }
      if (errInfo?.code === "429") {
        console.warn("[route] ODsay 일일 호출 한도 초과");
        return { available: false, reason: "ODsay 일일 호출 한도를 초과했어요. 잠시 후 다시 시도해주세요.", reasonCode: "ODSAY_QUOTA_EXCEEDED" };
      }
      return { available: false, reason: errInfo?.msg || errInfo?.message || "ODsay 오류", reasonCode: "ODSAY_ERROR" };
    }
    const paths = data.result?.path;
    if (!Array.isArray(paths) || paths.length === 0) {
      return { available: false, reason: "검색 결과 없음", reasonCode: "NO_ROUTE_FOUND" };
    }

    // OPT=0(추천경로)의 1순위를 그대로 쓴다 — ODsay가 이미 실제 소요시간 기준으로 정렬해서 주므로,
    // 지하철만 있는 경로를 임의로 우선시키면 남산타워처럼 버스가 꼭 필요한 목적지의 실제 경로를 놓치게 된다.
    return normalizeOdsayPath(paths[0]);
  } catch (err) {
    console.warn("[route] ODsay 호출 실패:", err.message);
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

async function searchAddressOSM(query) {
  const url =
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}` +
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

async function searchPlaces(query) {
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

// ODsay 무료(Basic) 요금제가 하루 30회 한도라, 자주 조회되는 "출발역 → 목적지" 조합은
// 미리 조회해서 backend/data/routeCache.json에 저장해두고 여기서 먼저 찾아본다.
// scripts/seedRouteCache.js가 매일 이 캐시를 조금씩 채워나간다 — 자세한 내용은 그 파일 참고.
// 캐시에 없는 조합만 그때 ODsay를 실시간으로 호출한다.
let routeCache = {};
try {
  routeCache = JSON.parse(fs.readFileSync(ROUTE_CACHE_PATH, "utf8"));
} catch (err) {
  console.warn("[route] 경로 캐시 로드 실패, 빈 캐시로 시작:", err.message);
}

function routeCacheKey(slat, slng, dlat, dlng) {
  const round = (n) => Number(n).toFixed(6);
  return `${round(slat)},${round(slng)},${round(dlat)},${round(dlng)}`;
}

// 대중교통 경로 검색 — ODsay API 연동 (ODSAY_API_KEY 미설정 시 { available: false } 반환)
// GET /api/route/transit?slat=&slng=&dlat=&dlng=
app.get("/api/route/transit", async (req, res) => {
  const slat = parseFloat(req.query.slat);
  const slng = parseFloat(req.query.slng);
  const dlat = parseFloat(req.query.dlat);
  const dlng = parseFloat(req.query.dlng);

  if (![slat, slng, dlat, dlng].every(Number.isFinite)) {
    return res.status(400).json({ error: "slat, slng, dlat, dlng 쿼리 파라미터가 필요합니다 (숫자)" });
  }

  const cacheKey = routeCacheKey(slat, slng, dlat, dlng);
  const cached = routeCache[cacheKey];
  if (cached) {
    return res.json(cached);
  }

  const route = await fetchTransitRoute(slat, slng, dlat, dlng);
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

// 관리자용: 즉시 재갱신 트리거 (필요할 때만 사용)
app.post("/api/stations/refresh", async (req, res) => {
  const ok = await refreshFromOpenAPI();
  res.json({ refreshed: ok, source: lastSource, stationCount: stationsCache.length });
});

initStations();

app.listen(PORT, () => {
  console.log(`[server] transit-guide-backend listening on http://localhost:${PORT}`);
});
