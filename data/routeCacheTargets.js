// 사전 캐싱 대상 "출발역 × 목적지" 조합 목록.
// 관광객이 실제로 묵을 가능성이 높은 지역의 역부터 우선순위를 두고, 나중에 점점 넓혀간다.
// 좌표 출처: 역은 backend/data/stations.csv(공식 데이터), 목적지는 mobile-app/src/data/destinations.js와 동일.
const ORIGIN_STATIONS = [
  { name: "명동역", lat: 37.561055, lng: 126.988271 },
  { name: "을지로3가역", lat: 37.566292, lng: 126.991773 },
  { name: "홍대입구역", lat: 37.556748, lng: 126.923643 },
  { name: "강남역", lat: 37.497958, lng: 127.027539 },
  { name: "이태원역", lat: 37.534485, lng: 126.994369 },
  { name: "동대문역사문화공원역", lat: 37.565597, lng: 127.009113 },
  { name: "종로3가역", lat: 37.570429, lng: 126.992095 },
  { name: "신촌역", lat: 37.555153, lng: 126.93689 },
];

const DESTINATIONS = [
  { name: "경복궁", lat: 37.575844, lng: 126.973576 },
  { name: "명동성당", lat: 37.5633, lng: 126.9873 },
  { name: "홍대입구", lat: 37.556748, lng: 126.923643 },
  { name: "동대문 DDP", lat: 37.5669, lng: 127.0094 },
  { name: "N서울타워", lat: 37.551216, lng: 126.988276 },
];

module.exports = { ORIGIN_STATIONS, DESTINATIONS };
