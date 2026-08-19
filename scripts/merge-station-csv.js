/**
 * merge-station-csv.js
 * ---------------------
 * 새로 받은 공식 역 좌표 CSV를 data/stations.csv에 병합하는 스크립트.
 * 9호선 1단계, 4단계, 신분당선 등 새 파일이 생길 때마다 이 스크립트로 계속 합치면 됩니다.
 *
 * 사용법:
 *   node scripts/merge-station-csv.js <새_CSV_경로> [호선라벨]
 *
 * 예시:
 *   node scripts/merge-station-csv.js ~/Downloads/서울교통공사_9호선_1단계.csv 9호선
 *   node scripts/merge-station-csv.js ~/Downloads/신분당선_역좌표.csv 신분당선
 *
 * [호선라벨]을 생략하면 CSV 안에 "호선" 컬럼이 있는 경우 그 값을 그대로 사용합니다
 * (서울교통공사 공식 CSV는 보통 숫자만 있는 "호선" 컬럼이 있어서, 이 경우 라벨을 지정해주는 걸 추천).
 *
 * 지원하는 컬럼명(자동 인식):
 *   역명: 역명, name, station, 역이름
 *   위도: 위도, lat, LAT, y좌표
 *   경도: 경도, lng, lon, LOT, x좌표
 *   호선: 호선, line
 *
 * 인코딩: UTF-8과 CP949(EUC-KR) 둘 다 자동 감지해서 처리합니다.
 * (공공데이터포털 CSV는 대부분 CP949라서 iconv-lite가 필요합니다: npm install iconv-lite)
 */

const fs = require("fs");
const path = require("path");
let iconv;
try {
  iconv = require("iconv-lite");
} catch {
  console.warn("[merge] iconv-lite가 설치되어 있지 않아 UTF-8로만 읽습니다. CP949 파일이면 `npm install iconv-lite` 후 다시 실행하세요.");
}

const STATIONS_CSV = path.join(__dirname, "..", "data", "stations.csv");

function readCsvSmart(filePath) {
  const buf = fs.readFileSync(filePath);
  // UTF-8로 먼저 시도, 깨진 문자(치환문자)가 많으면 CP949로 재시도
  let text = buf.toString("utf-8");
  const brokenCount = (text.match(/\uFFFD/g) || []).length;
  if ((brokenCount > 0 || /[^\x00-\x7F가-힣ㄱ-ㅎㅏ-ㅣ,.\-()·\s\d]/.test(text)) && iconv) {
    try {
      const cp949Text = iconv.decode(buf, "cp949");
      // CP949로 디코딩했을 때 한글이 더 정상적으로 보이면 채택
      if ((cp949Text.match(/[가-힣]/g) || []).length > (text.match(/[가-힣]/g) || []).length) {
        text = cp949Text;
      }
    } catch {
      /* utf-8 유지 */
    }
  }
  return text;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = lines.slice(1).filter((l) => l.trim()).map((line) => {
    const cols = line.split(",");
    const row = {};
    headers.forEach((h, i) => (row[h] = (cols[i] || "").trim()));
    return row;
  });
  return { headers, rows };
}

function findColumn(headers, candidates) {
  for (const c of candidates) {
    const found = headers.find((h) => h === c || h.toLowerCase() === c.toLowerCase());
    if (found) return found;
  }
  return null;
}

function normalizeStationName(name) {
  name = name.trim();
  return name.endsWith("역") ? name : name + "역";
}

function lineSortKey(l) {
  const m = l.match(/(\d+)호선/);
  if (m) return [0, parseInt(m[1], 10)];
  return [1, l];
}

function main() {
  const [, , newCsvPath, lineLabelArg] = process.argv;
  if (!newCsvPath) {
    console.error("사용법: node scripts/merge-station-csv.js <새_CSV_경로> [호선라벨]");
    process.exit(1);
  }
  if (!fs.existsSync(newCsvPath)) {
    console.error("파일을 찾을 수 없습니다:", newCsvPath);
    process.exit(1);
  }

  // 1) 기존 stations.csv 로드
  const existing = new Map(); // name -> { lines: Set, lat, lng }
  if (fs.existsSync(STATIONS_CSV)) {
    const { rows } = parseCsv(fs.readFileSync(STATIONS_CSV, "utf-8"));
    for (const r of rows) {
      existing.set(r.name, { lines: new Set(r.line.split("·")), lat: r.lat, lng: r.lng });
    }
  }
  console.log(`[merge] 기존 역 수: ${existing.size}`);

  // 2) 새 CSV 로드 (인코딩 자동 감지)
  const text = readCsvSmart(newCsvPath);
  const { headers, rows: newRows } = parseCsv(text);

  const nameCol = findColumn(headers, ["역명", "name", "station", "역이름"]);
  const latCol = findColumn(headers, ["위도", "lat", "LAT", "y좌표"]);
  const lngCol = findColumn(headers, ["경도", "lng", "lon", "LOT", "x좌표"]);
  const lineCol = findColumn(headers, ["호선", "line"]);

  if (!nameCol || !latCol || !lngCol) {
    console.error("[merge] 필수 컬럼(역명/위도/경도)을 찾지 못했습니다. CSV 헤더:", headers);
    process.exit(1);
  }

  let added = 0;
  let merged = 0;
  for (const r of newRows) {
    const name = normalizeStationName(r[nameCol]);
    const lat = r[latCol];
    const lng = r[lngCol];
    if (!lat || !lng) continue;

    let line = lineLabelArg;
    if (!line && lineCol) {
      const raw = r[lineCol].trim();
      line = /호선|선$/.test(raw) ? raw : `${raw}호선`;
    }
    if (!line) line = "미상";

    if (existing.has(name)) {
      const before = existing.get(name).lines.size;
      existing.get(name).lines.add(line);
      if (existing.get(name).lines.size > before) merged++;
    } else {
      existing.set(name, { lines: new Set([line]), lat, lng });
      added++;
    }
  }

  // 3) 기존 파일 백업 후 저장
  if (fs.existsSync(STATIONS_CSV)) {
    const backupPath = STATIONS_CSV.replace(".csv", `.backup-${Date.now()}.csv`);
    fs.copyFileSync(STATIONS_CSV, backupPath);
    console.log(`[merge] 기존 파일 백업: ${backupPath}`);
  }

  const outLines = ["name,line,lat,lng"];
  for (const [name, v] of existing) {
    const lines = [...v.lines].sort((a, b) => {
      const ka = lineSortKey(a), kb = lineSortKey(b);
      return ka[0] - kb[0] || (typeof ka[1] === "number" && typeof kb[1] === "number" ? ka[1] - kb[1] : String(ka[1]).localeCompare(String(kb[1])));
    });
    outLines.push(`${name},${lines.join("·")},${v.lat},${v.lng}`);
  }
  fs.writeFileSync(STATIONS_CSV, outLines.join("\n") + "\n", "utf-8");

  console.log(`[merge] 신규 추가: ${added}개, 환승역으로 병합: ${merged}개`);
  console.log(`[merge] 최종 역 수: ${existing.size}`);
  console.log(`[merge] 저장 완료: ${STATIONS_CSV}`);
}

main();
