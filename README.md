# transit-guide-backend

외국인 대중교통 안내 앱의 "현재 위치에서 가장 가까운 역 계산" 백엔드 서버입니다.
인증키와 정부 API 호출을 서버 안에 숨기고, 앱은 이 서버의 간단한 API만 호출하면 됩니다.

## 왜 이렇게 만들었나

- **인증키 보호**: 정부 API 인증키를 앱(프론트엔드)에 직접 넣으면 앱을 뜯어보는 누구나 키를 훔쳐갈 수 있어요. 서버 안에만 있으면 안전해요.
- **역 좌표는 자주 안 바뀜**: 데이터가 분기별로만 갱신되니, 매 요청마다 정부 API를 부르지 않고 서버 메모리에 캐싱해서 응답 속도도 빠르고 정부 API 호출 횟수 제한에도 안전해요.
- **CSV 우선, API는 선택**: 기본은 로컬 CSV 파일로 확실하게 작동하고, 인증키를 넣으면 주기적으로 정부 API에서 자동 갱신을 "시도"합니다. 실패해도 CSV로 조용히 대체되니 서비스가 죽지 않아요.

## 1. 설치

```bash
cd backend
npm install
cp .env.example .env
```

## 2. (선택) 실시간 갱신을 쓰고 싶다면

1. https://data.seoul.go.kr/together/guide/useGuide.do 에서 "일반 인증키 신청" → 인증키 발급
2. data.seoul.go.kr에서 **"서울교통공사_1_8호선 역사 좌표"** 검색 → 데이터셋 상세 페이지에서 정확한 **서비스명**(영문 코드) 확인
3. `.env` 파일에 `SEOUL_API_KEY`, `SEOUL_SERVICE_NAME` 채워넣기

이 값들을 비워두면 서버는 `data/stations.csv`만 사용합니다 — 그래도 정상 작동해요.

**업데이트 (2026-08-19)**: 공식 CSV로 이미 교체 완료했습니다. `data/stations.csv`에 **1~8호선 + 9호선 2·3단계, 총 249개 고유 역**(환승역은 여러 호선을 한 줄로 병합)이 들어있어요. 데모용 20개 역 버전은 `data/stations.demo20.csv.bak`으로 백업되어 있습니다.

이 데이터 교체 과정에서 이전에 임의로 추정했던 명동역 좌표가 실제 공식 좌표와 약 400~500m 차이가 났던 것도 확인해서 바로잡았어요 (앱 쪽 `STATION.entrance.gps`, `DESTINATION_ARRIVAL.gps`도 함께 수정).

**아직 빠진 부분**: 9호선은 "2·3단계"(언주~중앙보훈병원 구간)만 반영됐어요. 9호선 1단계(개화~신논현)와 4단계(향후 연장 구간), 그리고 신분당선·공항철도·경의중앙선처럼 서울교통공사가 아닌 다른 사업자가 운영하는 노선은 이 데이터셋에 없어서 각 운영사나 국가철도공단 "철도 데이터 포털(data.kric.go.kr)"에서 별도로 구해야 해요.

## 3. 실행

```bash
npm start
```

`http://localhost:3001` 에서 서버가 뜹니다.

## 4. API

### GET /health
서버 상태와 캐시 정보 확인.
```bash
curl http://localhost:3001/health
```

### GET /api/stations
전체 역 목록.
```bash
curl http://localhost:3001/api/stations
```

### GET /api/stations/nearest?lat=&lng=&limit=
**앱이 실제로 쓸 핵심 엔드포인트.** 좌표를 넘기면 가장 가까운 역을 거리순으로 반환.
```bash
curl "http://localhost:3001/api/stations/nearest?lat=37.5636&lng=126.9834&limit=3"
```
응답 예시:
```json
{
  "query": { "lat": 37.5636, "lng": 126.9834 },
  "results": [
    { "name": "명동역", "line": "4호선", "lat": 37.5636, "lng": 126.9834, "distance_m": 0 },
    { "name": "을지로입구역", "line": "2호선", "lat": 37.566, "lng": 126.9827, "distance_m": 270 }
  ],
  "source": "csv"
}
```

### POST /api/stations/refresh
정부 API 갱신을 즉시 트리거 (관리자용, 평소엔 24시간마다 자동 실행됨).

### GET /api/route/transit?slat=&slng=&dlat=&dlng=
출발/도착 좌표로 실제 대중교통(지하철+버스) 경로를 검색합니다. [ODsay](https://lab.odsay.com) API를 연동하며, `.env`에 `ODSAY_API_KEY`가 없으면 `{ "available": false }`만 반환합니다 — 앱은 이 경우 "아직 조회된 경로가 없다"고 정직하게 안내하고 네이버지도 링크로 대신합니다.

```bash
curl "http://localhost:3001/api/route/transit?slat=37.4921&slng=126.8233&dlat=37.5758&dlng=126.9736"
```
응답 예시(지하철만 이용하는 경로):
```json
{
  "available": true,
  "summary": { "totalTimeMin": 52, "transfers": 1, "fare": 1850 },
  "segments": [
    { "mode": "subway", "line": "1호선", "startStation": "온수", "endStation": "종로3가", "stationCount": 15, "minutes": 34, "boardingCar": "6-1", "startExitNo": "4" },
    { "mode": "subway", "line": "3호선", "startStation": "종로3가", "endStation": "경복궁", "stationCount": 2, "minutes": 4, "endExitNo": "4" }
  ],
  "source": "ODsay 대중교통 길찾기"
}
```
버스가 포함된 경로(예: 남산타워처럼 지하철역에서 내려 버스로 갈아타야 하는 경우)는 `segments` 배열에 `mode: "bus"` 항목이 실제 탑승 순서대로 섞여서 들어갑니다:
```json
{
  "available": true,
  "summary": { "totalTimeMin": 21, "transfers": 0, "fare": 1100 },
  "segments": [
    { "mode": "bus", "busNo": "01A", "startStation": "충무로역2번출구", "endStation": "남산서울타워", "stationCount": 6, "minutes": 16 }
  ],
  "source": "ODsay 대중교통 길찾기"
}
```
지하철만으로 구성된 경로를 임의로 우선시키지 않고, ODsay가 추천하는 1순위 경로(`OPT=0`)를 그대로 반환합니다 — 남산타워처럼 버스가 꼭 필요한 목적지의 실제 경로를 놓치지 않기 위해서입니다.

출발/도착이 700m 이내면 ODsay가 아예 대중교통 경로를 계산해주지 않습니다(자체적으로 "걸어가는 게 낫다"고 판단). 이 경우 `available: false`지만 `walkable: true`와 함께 도보 거리·시간을 계산해서 돌려줍니다:
```json
{ "available": false, "reason": "too_close", "walkable": true, "walkMeters": 420, "walkMinutes": 6 }
```

**API 키 발급 (무료)**:
1. https://lab.odsay.com 에서 회원가입
2. "애플리케이션 등록" → 서비스 유형 **Basic**(개인/무료) 선택 → 등록
3. 발급된 API Key를 `.env`에 `ODSAY_API_KEY=발급받은키` 로 추가

키가 없어도 서버는 정상 작동합니다 — 이 기능만 비활성화될 뿐입니다.

⚠️ ODsay 상표 사용 가이드에 따라, 이 API로 얻은 경로 정보를 화면에 보여줄 때는 "powered by www.ODsay.com" 표기가 필요합니다 (모바일 앱에서 이미 "출처: ODsay 대중교통 길찾기"로 표시하고 있어요).

### GET /api/geocode/search?query=
주소 또는 장소 이름(예: "명동 게스트하우스")으로 좌표를 검색합니다. 숙소 등록처럼 사용자마다 다른 위치를 앱이 미리 알 수 없을 때 씁니다. [카카오 로컬 API](https://developers.kakao.com)를 연동하며, `.env`에 `KAKAO_REST_API_KEY`가 없으면 `{ "available": false }`만 반환합니다 — 앱은 이 경우 "현재 위치를 숙소로 저장" 방식으로 대체합니다.

```bash
curl "http://localhost:3001/api/geocode/search?query=명동성당"
```
응답 예시:
```json
{
  "available": true,
  "results": [
    { "name": "명동성당", "address": "서울 중구 명동길 74", "lat": 37.563325, "lng": 126.987438, "category": "종교시설" }
  ],
  "source": "카카오 로컬 검색"
}
```

**API 키 발급 (무료)**:
1. https://developers.kakao.com 에서 회원가입
2. "내 애플리케이션" → "애플리케이션 추가하기"
3. 생성된 앱의 "앱 키" 중 **REST API 키**를 복사 (JavaScript 키가 아님에 주의)
4. `.env`에 `KAKAO_REST_API_KEY=발급받은키` 로 추가

키가 없어도 서버는 정상 작동합니다 — 이 기능만 비활성화될 뿐입니다.

## 5. 앱(React Native)에서 호출하는 법

CORS는 브라우저에서만 문제가 되고, React Native 앱에서는 문제되지 않아요. 그냥 평범하게 fetch하면 됩니다.

```javascript
async function getNearestStation(lat, lng) {
  const res = await fetch(`https://your-server.com/api/stations/nearest?lat=${lat}&lng=${lng}&limit=1`);
  const data = await res.json();
  return data.results[0]; // { name, line, lat, lng, distance_m }
}
```

이 프로토타입(웹 artifact)의 `findNearestStation()` 함수를 실제 앱에서는 이 fetch 호출로 바꾸면 됩니다. 로직(하버사인 거리 계산)은 이미 서버로 옮겨져 있어서 앱은 결과만 받아쓰면 돼요.

## 6. 배포

작은 트래픽이면 Render, Railway, Fly.io 같은 곳의 무료/저가 플랜으로 충분히 돌릴 수 있어요. 배포 시 `.env`의 `ALLOWED_ORIGIN`을 실제 앱 도메인/스킴으로 좁혀서 아무 사이트나 이 서버를 호출하지 못하게 하는 걸 추천해요.

## 나중에 CSV를 추가로 받으면 (9호선 1단계, 다른 노선 등)

새 공식 CSV를 받을 때마다 아래 스크립트로 바로 합칠 수 있게 만들어뒀습니다. 병합 전 자동으로 백업도 남겨요.

```bash
node scripts/merge-station-csv.js <새_CSV_경로> [호선라벨]

# 예시
node scripts/merge-station-csv.js ~/Downloads/9호선_1단계.csv 9호선
node scripts/merge-station-csv.js ~/Downloads/신분당선.csv 신분당선
```

- UTF-8/CP949 인코딩을 자동으로 감지해서 처리해요 (`npm install`로 `iconv-lite`가 이미 설치됨)
- 역명/위도/경도/호선 컬럼명을 한국어·영어 여러 패턴으로 자동 인식해요
- 이미 있는 역이면 호선 정보만 병합(환승역 자동 처리), 없으면 새로 추가해요
- 실행할 때마다 `data/stations.backup-{시각}.csv`로 이전 버전을 자동 백업해요

## 다음에 할 일
- [ ] data.go.kr에서 공식 276개 역 CSV 다운로드해서 `data/stations.csv` 교체
- [ ] (선택) 실시간 API 서비스명 확인해서 .env에 채우기
- [ ] 9호선·신분당선·공항철도 등 서울교통공사 외 노선 데이터도 별도 출처(각 운영사, data.kric.go.kr)에서 추가
- [ ] 배포 후 ALLOWED_ORIGIN 실제 도메인으로 좁히기
