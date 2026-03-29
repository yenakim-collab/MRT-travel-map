/* ============================================================
   Travel Route Map  –  app.js
   ============================================================ */

// ─── Canvas renderer (공유) ──────────────────────────────────
// Leaflet SVG 레이어는 html2canvas 캡처 불가 → canvas renderer 전환
// 모든 벡터 레이어(GeoJSON, 폴리라인)가 같은 <canvas>에 그려짐
// padding: 0 → 캔버스가 지도 뷰포트와 정확히 같은 크기 = 오프셋 계산 불필요
const canvasRenderer = L.canvas({ padding: 0 });

// ─── Map initialisation ─────────────────────────────────────
// zoom:2 시 세계 타일이 1024px 정방형 → 대형 화면에서 극지방 빈 영역 노출
// fitBounds로 화면 크기에 맞는 zoom을 자동 계산
const map = L.map('map', {
  minZoom: 2,
  maxZoom: 18,
  zoomControl: true,
  worldCopyJump: true,
});
map.fitBounds([[-75, -165], [75, 165]]);

// ─── 지형 타일 (MapTiler Voyager – 상업 무료 플랜) ────────────
// ✅ 상업적 사용 허용 (무료 플랜: 월 100,000 맵로드)
// ✅ API 키 필요 → https://cloud.maptiler.com 에서 무료 계정 생성 후 발급
// crossOrigin: anonymous → 타일 이미지를 canvas에 drawImage 가능 (export용)
const MAPTILER_KEY = 'lTutsYkcVmdFzWKdIJqy';
L.tileLayer(`https://api.maptiler.com/maps/dataviz/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`, {
  crossOrigin: 'anonymous',
  attribution: '© <a href="https://www.maptiler.com/copyright/">MapTiler</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
  maxZoom: 19,
}).addTo(map);

// flex 레이아웃 계산 완료 후 컨테이너 크기 재반영 + 저장된 코스 복원
setTimeout(() => {
  map.invalidateSize();
  loadState();
  appReady = true; // 이후 saveState() 호출 허용
  if (waypoints.length > 0) {
    // localStorage에서 복원된 imgUrl을 export용 canvas 캐시에 미리 로드
    waypoints.forEach(wp => { if (wp.imgUrl) preloadWpImage(wp.imgUrl); });
    render();
    if (showPhoto) loadMissingImages();
  } else {
    map.fitBounds([[-75, -165], [75, 165]]);
  }
}, 0);

// ─── Antimeridian fix ────────────────────────────────────────
// 러시아 등 날짜변경선(±180°)을 가로지르는 폴리곤 가로 밴드 artifact 제거
function fixAntimeridian(obj) {
  const fixSeq = (coords) => {
    const out = [[...coords[0]]];
    for (let i = 1; i < coords.length; i++) {
      const prev = out[i - 1][0];
      let lng = coords[i][0];
      while (lng - prev > 180) lng -= 360;
      while (lng - prev < -180) lng += 360;
      out.push([lng, coords[i][1]]);
    }
    return out;
  };
  const fixRings = (rings) => rings.map(fixSeq);
  const fixFeature = (f) => {
    if (!f.geometry) return f;
    const g = f.geometry;
    if (g.type === 'Polygon')
      return { ...f, geometry: { ...g, coordinates: fixRings(g.coordinates) } };
    if (g.type === 'MultiPolygon')
      return { ...f, geometry: { ...g, coordinates: g.coordinates.map(fixRings) } };
    if (g.type === 'MultiLineString')
      return { ...f, geometry: { ...g, coordinates: g.coordinates.map(fixSeq) } };
    return f;
  };
  if (obj.type === 'FeatureCollection')
    return { ...obj, features: obj.features.map(fixFeature) };
  if (obj.type === 'Feature') return fixFeature(obj);
  return fixFeature({ type: 'Feature', geometry: obj, properties: {} }).geometry;
}

// ─── World base map (TopoJSON, canvas renderer) ──────────────
fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json')
  .then((r) => r.json())
  .then((world) => {
    // 국가 간 경계선 (타일 위에 오버레이)
    L.geoJSON(
      fixAntimeridian(topojson.mesh(world, world.objects.countries, (a, b) => a !== b)),
      {
        renderer: canvasRenderer,
        style: { fill: false, color: '#F5F3F3', weight: 1.5, opacity: 1 },
        interactive: false,
      }
    ).addTo(map);
  });

// ─── State ──────────────────────────────────────────────────
let waypoints = [];           // [{ name, lat, lng, wikiName, imgUrl }]
let transportModes = [];      // transport[i] = mode between waypoints[i] and [i+1]
let isLoop = false;           // 출발=도착 루프 여부
let loopTransportMode = 'bus'; // 루프 닫힘 세그먼트 이동수단
let dragSrcIndex = null;      // 드래그 중인 코스 인덱스
let showBadge  = true;        // 이동수단 배지 표시 여부
let showPhoto  = false;       // 여행지 이미지 표시 여부
let showCourse  = true;       // 코스(경로선+화살표) 표시 여부
let markerScale = 1.0;        // 마커 에셋 배율 (1 / 1.5 / 2)
let uploadTargetIndex = null; // 사진 업로드 대상 인덱스
let isEditMode = false;       // 여행지명 편집 모드
let isPinMode = false;        // 핀 찍기 모드
let pinMarker = null;         // 핀 모드 임시 마커
let appReady = false;         // loadState 완료 전에 saveState가 빈 데이터를 덮어쓰는 것 방지
let visibleModes = { bus: true, plane: true, ferry: true, train: true }; // 개별 이동수단 표시 여부

// ─── LocalStorage 저장/복원 ──────────────────────────────────
const STORAGE_KEY = 'travel-map-state';

function saveState() {
  if (!appReady) return; // loadState 완료 전에 빈 데이터로 덮어쓰기 방지
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      waypoints, transportModes, showBadge, showPhoto, showCourse, markerScale, isLoop, loopTransportMode, visibleModes,
    }));
  } catch (e) {
    const slim = waypoints.map(wp => ({ ...wp, imgUrl: wp.imgUrl?.startsWith('data:') ? null : wp.imgUrl }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ waypoints: slim, transportModes, showBadge, showPhoto, showCourse, markerScale, isLoop, loopTransportMode, visibleModes }));
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const state = JSON.parse(raw);
    waypoints = state.waypoints || [];
    transportModes = state.transportModes || [];
    showBadge   = state.showBadge   ?? true;
    showPhoto   = state.showPhoto   ?? false;
    showCourse  = state.showCourse  ?? true;
    markerScale = state.markerScale ?? 1.0;
    isLoop = state.isLoop ?? false;
    loopTransportMode = state.loopTransportMode ?? 'bus';
    if (state.visibleModes) visibleModes = state.visibleModes;
    document.getElementById('badge-toggle')?.classList.toggle('active', showBadge);
    document.getElementById('photo-toggle')?.classList.toggle('active', showPhoto);
    document.getElementById('course-toggle')?.classList.toggle('active', showCourse);
    // 저장된 배율로 버튼 active 상태 복원
    document.querySelectorAll('.scale-btn').forEach(btn => {
      btn.classList.toggle('active', parseFloat(btn.dataset.scale) === markerScale);
    });

    // 레거시 마이그레이션: 첫/마지막 waypoint 중복 감지 → isLoop으로 변환
    if (!isLoop && waypoints.length >= 3) {
      const first = waypoints[0], last = waypoints[waypoints.length - 1];
      if (Math.hypot(first.lat - last.lat, first.lng - last.lng) < 0.002 || first.name === last.name) {
        loopTransportMode = transportModes[transportModes.length - 1] || 'bus';
        waypoints.pop();
        if (transportModes.length >= waypoints.length) transportModes.pop();
        isLoop = true;
      }
    }
    updateBadgeUI();
  } catch { /* 무시 */ }
}

// ─── Layer groups ─────────────────────────────────────────────
const polylineLayer = L.layerGroup().addTo(map);
const badgeLayer    = L.layerGroup();            // 교통수단 배지 – showBadge 상태로 map 연결 관리
const arrowLayer    = L.layerGroup().addTo(map); // 방향 삼각형 (pixel 보간 → zoom마다 재계산)
const markerLayer   = L.layerGroup().addTo(map);

// ─── Transport definitions ────────────────────────────────────
// svgPath: 사용자 제공 아이콘 path, viewBox: 각 아이콘 고유 viewBox
const TRANSPORT = {
  bus: {
    label: '버스',
    dashArray: null,
    viewBox: '0 0 20 20',
    svgPath: 'M6 18V18.5C6 18.9167 5.85417 19.2708 5.5625 19.5625C5.27083 19.8542 4.91667 20 4.5 20C4.08333 20 3.72917 19.8542 3.4375 19.5625C3.14583 19.2708 3 18.9167 3 18.5V16.95C2.7 16.6167 2.45833 16.2458 2.275 15.8375C2.09167 15.4292 2 14.9833 2 14.5V5C2 3.61667 2.64167 2.60417 3.925 1.9625C5.20833 1.32083 7.23333 1 10 1C12.8667 1 14.9167 1.30833 16.15 1.925C17.3833 2.54167 18 3.56667 18 5V14.5C18 14.9833 17.9083 15.4292 17.725 15.8375C17.5417 16.2458 17.3 16.6167 17 16.95V18.5C17 18.9167 16.8542 19.2708 16.5625 19.5625C16.2708 19.8542 15.9167 20 15.5 20C15.0833 20 14.7292 19.8542 14.4375 19.5625C14.1458 19.2708 14 18.9167 14 18.5V18H6ZM4 9H16V6H4V9ZM6.5 15C6.91667 15 7.27083 14.8542 7.5625 14.5625C7.85417 14.2708 8 13.9167 8 13.5C8 13.0833 7.85417 12.7292 7.5625 12.4375C7.27083 12.1458 6.91667 12 6.5 12C6.08333 12 5.72917 12.1458 5.4375 12.4375C5.14583 12.7292 5 13.0833 5 13.5C5 13.9167 5.14583 14.2708 5.4375 14.5625C5.72917 14.8542 6.08333 15 6.5 15ZM13.5 15C13.9167 15 14.2708 14.8542 14.5625 14.5625C14.8542 14.2708 15 13.9167 15 13.5C15 13.0833 14.8542 12.7292 14.5625 12.4375C14.2708 12.1458 13.9167 12 13.5 12C13.0833 12 12.7292 12.1458 12.4375 12.4375C12.1458 12.7292 12 13.0833 12 13.5C12 13.9167 12.1458 14.2708 12.4375 14.5625C12.7292 14.8542 13.0833 15 13.5 15Z',
  },
  plane: {
    label: '비행기',
    dashArray: '5 8',
    viewBox: '0 0 21 21',
    svgPath: 'M7.675 20.025C7.34167 20.1083 7.06267 20.0627 6.838 19.888C6.61267 19.7127 6.5 19.4583 6.5 19.125C6.5 18.975 6.546 18.8167 6.638 18.65C6.72933 18.4833 6.83333 18.35 6.95 18.25L8.5 17.075V11.825L1.475 13.9C1.075 14.0167 0.729333 13.9707 0.438 13.762C0.146 13.554 0 13.2333 0 12.8C0 12.5833 0.0626667 12.3707 0.188 12.162C0.312667 11.954 0.466667 11.8 0.65 11.7L8.5 7.075V1.65C8.5 1.18333 8.65833 0.791667 8.975 0.475C9.29167 0.158333 9.68333 0 10.15 0C10.6167 0 11.0083 0.158333 11.325 0.475C11.6417 0.791667 11.8 1.18333 11.8 1.65V7.075L19.65 11.7C19.8333 11.8 19.9877 11.9583 20.113 12.175C20.2377 12.3917 20.3 12.6083 20.3 12.825C20.3 13.2417 20.1543 13.554 19.863 13.762C19.571 13.9707 19.225 14.0167 18.825 13.9L11.8 11.825V17.075L13.35 18.25C13.4667 18.35 13.5707 18.4833 13.662 18.65C13.754 18.8167 13.8 18.975 13.8 19.125C13.8 19.4583 13.6873 19.7127 13.462 19.888C13.2373 20.0627 12.9583 20.1083 12.625 20.025L10.15 19.3L7.675 20.025Z',
  },
  ferry: {
    label: '페리/크루즈',
    dashArray: '8 6',
    viewBox: '0 0 20 20',
    svgPath: 'M17.2 18C16.129 18 15.058 17.685 14.077 17.118C13.78 16.947 13.42 16.947 13.114 17.118C12.1689 17.6744 11.0922 17.9678 9.9955 17.9678C8.89881 17.9678 7.82208 17.6744 6.877 17.118C6.58 16.947 6.22 16.947 5.914 17.118C4.942 17.685 3.871 18 2.8 18H1.9C1.405 18 1 18.405 1 18.9C1 19.395 1.405 19.8 1.9 19.8H2.8C4.042 19.8 5.266 19.485 6.4 18.909C7.51368 19.4814 8.74782 19.78 10 19.78C11.2522 19.78 12.4863 19.4814 13.6 18.909C14.734 19.494 15.958 19.8 17.2 19.8H18.1C18.595 19.8 19 19.395 19 18.9C19 18.405 18.595 18 18.1 18H17.2ZM2.755 16.2H2.8C3.943 16.2 4.978 15.705 5.797 15.003C6.148 14.697 6.652 14.697 7.003 15.003C7.822 15.705 8.857 16.2 10 16.2C11.143 16.2 12.178 15.705 12.997 15.003C13.348 14.697 13.852 14.697 14.203 15.003C15.022 15.705 16.057 16.2 17.2 16.2H17.245L18.955 10.188C19.054 9.855 18.991 9.234 18.361 9.036L17.2 8.658V4.5C17.2 3.51 16.39 2.7 15.4 2.7H12.7V0.9C12.7 0.405 12.295 0 11.8 0H8.2C7.705 0 7.3 0.405 7.3 0.9V2.7H4.6C3.61 2.7 2.8 3.51 2.8 4.5V8.658L1.639 9.036C1.072 9.207 0.91 9.792 1.045 10.188L2.755 16.2Z',
  },
  train: {
    label: '기차',
    dashArray: null,
    viewBox: '0 0 20 20',
    svgPath: 'M5.5 17.4068C4.51267 17.3509 3.6825 16.9576 3.0095 16.2268C2.3365 15.4959 2 14.6249 2 13.6138V4.2035C2 2.75233 2.65958 1.689 3.97875 1.0135C5.29792 0.337833 7.37217 0 10.2015 0C13.1332 0 15.2336 0.325333 16.5027 0.975999C17.7719 1.6265 18.4065 2.70233 18.4065 4.2035V13.6138C18.4065 14.6249 18.07 15.4959 17.397 16.2268C16.724 16.9576 15.8938 17.3509 14.9065 17.4068L16.5015 18.4638C16.7335 18.6169 16.8102 18.8303 16.7315 19.104C16.6528 19.3775 16.4726 19.5142 16.1907 19.5142H4.21575C3.93392 19.5142 3.75367 19.3775 3.675 19.104C3.59633 18.8303 3.673 18.6169 3.905 18.4638L5.5 17.4068ZM4.275 8.275H9.20325V5.275H4.275V8.275ZM11.2032 8.275H16.1315V5.275H11.2032V8.275ZM6.739 14.2393C7.15567 14.2393 7.50983 14.0934 7.8015 13.8018C8.09317 13.5101 8.239 13.1559 8.239 12.7393C8.239 12.3226 8.09317 11.9684 7.8015 11.6768C7.50983 11.3851 7.15567 11.2393 6.739 11.2393C6.32233 11.2393 5.96817 11.3851 5.6765 11.6768C5.38483 11.9684 5.239 12.3226 5.239 12.7393C5.239 13.1559 5.38483 13.5101 5.6765 13.8018C5.96817 14.0934 6.32233 14.2393 6.739 14.2393ZM13.6675 14.2393C14.0842 14.2393 14.4383 14.0934 14.73 13.8018C15.0217 13.5101 15.1675 13.1559 15.1675 12.7393C15.1675 12.3226 15.0217 11.9684 14.73 11.6768C14.4383 11.3851 14.0842 11.2393 13.6675 11.2393C13.2508 11.2393 12.8967 11.3851 12.605 11.6768C12.3133 11.9684 12.1675 12.3226 12.1675 12.7393C12.1675 13.1559 12.3133 13.5101 12.605 13.8018C12.8967 14.0934 13.2508 14.2393 13.6675 14.2393Z',
  },
};

// SVG → 인라인 HTML (지도 배지용, 각 아이콘의 고유 viewBox 사용)
function makeSvgHtml(t, size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="${t.viewBox}" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="${t.svgPath}"/></svg>`;
}

// SVG → Image 객체 (Canvas export용, data URL 방식 – file:// CORS 우회)
const ICON_IMGS = {};
Object.entries(TRANSPORT).forEach(([key, t]) => {
  const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${t.viewBox}"><path fill="%23222" d="${t.svgPath}"/></svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml,' + svgStr;
  ICON_IMGS[key] = img;
});

// ─── 여행지 이미지 (Wikipedia) ───────────────────────────────
// canvas export용 Image 객체 캐시 (data URL 포함)
const wpImgCache = {};

function preloadWpImage(url) {
  if (!url || wpImgCache[url]) return;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  wpImgCache[url] = img;
}

// ─── 이미지 fetch (Unsplash API – 상업적 무료) ───────────────
// ✅ 상업적 이용 완전 무료, 저작권 표기 불필요
// ✅ https://unsplash.com/developers 에서 발급
const UNSPLASH_KEY = '0Z8MHCJVc0gAXJBU1FvLOQo0gVP4odUPVg8autwXcDo';

const NOMINATIM_HEADERS = {
  'User-Agent': 'TravelRouteMap/1.0 (https://your-company-domain.com; contact@your-company.com)',
  'Referer': 'https://your-company-domain.com',
};

// 비라틴 지명(한글·한자 등)일 때 역지오코딩으로 영문명 획득
async function getEnglishPlaceName(lat, lng) {
  try {
    // zoom=10 → 도시 레벨 결과 반환 (동네/구 수준 방지)
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=en&namedetails=1&zoom=10`,
      { headers: NOMINATIM_HEADERS }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.namedetails?.['name:en']
      || data.address?.city
      || data.address?.town
      || data.address?.county
      || data.name
      || null;
  } catch { return null; }
}

async function fetchLocationImage(name, lat = null, lng = null) {
  let url = (await fetchUnsplashPhotos(name, 1))[0];
  // 비라틴 문자 포함 → 영문명으로 재시도
  if (!url && lat !== null && lng !== null && /[^\x00-\x7F]/.test(name)) {
    const enName = await getEnglishPlaceName(lat, lng);
    if (enName) url = (await fetchUnsplashPhotos(enName, 1))[0];
  }
  if (url) preloadWpImage(url);
  return url || null;
}

async function fetchUnsplashPhotos(name, count = 6) {
  try {
    // 쉼표/하이픈/대시 기준 첫 파트만 사용
    let query = name.split(/[,\-–—]/)[0].trim();
    let urls = await _unsplashSearch(query, count);
    // 결과 없고 여러 단어면 → 첫 단어만으로 재시도 (e.g. "Santorini Old Port" → "Santorini")
    if (!urls.length && query.includes(' ')) {
      query = query.split(' ')[0].trim();
      urls = await _unsplashSearch(query, count);
    }
    return urls;
  } catch { return []; }
}

async function _unsplashSearch(query, count) {
  const res = await fetch(
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${count}&orientation=squarish`,
    { headers: { 'Authorization': `Client-ID ${UNSPLASH_KEY}` } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  const urls = (data.results || []).map(r => r.urls?.small).filter(Boolean);
  urls.forEach(url => preloadWpImage(url));
  return urls;
}

// ─── Photo Picker ─────────────────────────────────────────────
const photoPickerOverlay = document.getElementById('photo-picker-overlay');
const photoPickerGrid    = document.getElementById('photo-picker-grid');
const photoPickerTitle   = document.getElementById('photo-picker-title');

async function openPhotoPicker(wpIndex) {
  uploadTargetIndex = wpIndex;
  const wp = waypoints[wpIndex];
  photoPickerTitle.textContent = `"${wp.name}" 사진 선택`;
  photoPickerGrid.innerHTML = '<div class="picker-loading">⏳ 사진 불러오는 중...</div>';
  photoPickerOverlay.classList.add('visible');

  let searchName = wp.wikiName || wp.name;
  let urls = await fetchUnsplashPhotos(searchName, 6);
  // 비라틴 지명이고 결과 없으면 영문명으로 재시도
  if (!urls.length && /[^\x00-\x7F]/.test(searchName)) {
    const enName = await getEnglishPlaceName(wp.lat, wp.lng);
    if (enName) urls = await fetchUnsplashPhotos(enName, 6);
  }
  // 여전히 없으면 지역명(wp.name)으로 한 번 더 시도
  if (!urls.length && wp.name !== searchName) {
    urls = await fetchUnsplashPhotos(wp.name, 6);
  }

  if (!urls.length) {
    photoPickerGrid.innerHTML = `<div class="picker-empty">사진을 찾을 수 없어요<br><small style="color:#bbb;font-size:11px">검색어: "${searchName}"</small></div>`;
    return;
  }

  photoPickerGrid.innerHTML = '';
  urls.forEach(url => {
    const el = document.createElement('div');
    el.className = 'picker-photo';
    el.style.backgroundImage = `url(${url})`;
    if (wp.imgUrl === url) el.classList.add('selected');
    el.addEventListener('click', () => {
      waypoints[uploadTargetIndex].imgUrl = url;
      preloadWpImage(url);
      render();
      closePhotoPicker();
    });
    photoPickerGrid.appendChild(el);
  });
}

function closePhotoPicker() {
  photoPickerOverlay.classList.remove('visible');
  uploadTargetIndex = null;
}

document.getElementById('photo-picker-close').addEventListener('click', closePhotoPicker);
photoPickerOverlay.addEventListener('click', (e) => {
  if (e.target === photoPickerOverlay) closePhotoPicker();
});
document.getElementById('photo-picker-upload').addEventListener('click', () => {
  const idx = uploadTargetIndex;
  closePhotoPicker();
  uploadTargetIndex = idx;
  document.getElementById('photo-upload-input').click();
});

// photo 모드 ON 시 이미지 없는 waypoint에 일괄 로딩
async function loadMissingImages() {
  const updates = await Promise.all(
    waypoints.map(async (wp, i) => {
      if (wp.imgUrl) return false;
      const url = await fetchLocationImage(wp.wikiName || wp.name, wp.lat, wp.lng);
      if (url) { waypoints[i].imgUrl = url; return true; }
      return false;
    })
  );
  if (updates.some(Boolean)) render();
}

// ─── 방위각 계산 (0°=북, 시계 방향) ────────────────────────
// SVG/Canvas transform rotate()와 동일한 방향 규약
function calcBearing(a, b) {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const Δλ = ((b.lng - a.lng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// ─── 방향 화살표 DivIcon ─────────────────────────────────────
function makeArrowIcon(bearing) {
  return L.divIcon({
    html: `<svg width="12" height="12" viewBox="-6 -6 12 12" style="display:block;overflow:visible">
      <polygon points="0,-5 4.5,4 -4.5,4" fill="#222" transform="rotate(${bearing})"/>
    </svg>`,
    className: '',
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });
}

// ─── 마커 pill 너비 추정 (deconfliction bounding box 계산용) ──
function estimatePillW(name) {
  // 한글은 ~11px, 라틴 ~7px per char
  const charW = /[\uAC00-\uD7A3]/.test(name) ? 10 : 7;
  const textW = Math.min(name.length, 14) * charW;
  // showCourse ON: 4(좌패딩) + 20(번호원) + 5(gap) + textW + 10(우패딩)
  // showCourse OFF: 10(좌패딩) + textW + 10(우패딩)
  const base = showCourse ? (textW + 39) : (textW + 20);
  return base * markerScale;
}

// ─── 마커 겹침 방지 오프셋 계산 ─────────────────────────────
function computeOffsets(pts, badgePts = []) {
  if (pts.length === 0) return [];
  // 배율 적용된 실제 크기
  const PR  = 32 * markerScale;
  const PH  = 26 * markerScale;
  const GAP = 5  * markerScale;
  const PAD = 8;
  const PIN_R = 14; // 핀 도트 보호 반경 (px)

  // 마커 유닛(사진+pill)의 bounding box
  function bbox(i, ox, oy) {
    const pw = estimatePillW(waypoints[i].name);
    const cx = pts[i].x + ox, cy = pts[i].y + oy;
    if (showPhoto) {
      const w = Math.max(PR * 2, pw);
      return { x: cx - w / 2 - PAD, y: cy - PR - PAD, w: w + PAD * 2, h: PR * 2 + GAP + PH + PAD * 2 };
    }
    return { x: cx - pw / 2 - PAD, y: cy - PH / 2 - PAD, w: pw + PAD * 2, h: PH + PAD * 2 };
  }

  // 핀 도트(실제 위치)의 보호 영역 — 어떤 마커 유닛도 이 안에 들어오면 안 됨
  function pinZone(pt) {
    return { x: pt.x - PIN_R, y: pt.y - PIN_R, w: PIN_R * 2, h: PIN_R * 2 };
  }

  function overlaps(a, b) {
    return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
  }

  function overlapArea(a, b) {
    const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return Math.max(0, ix) * Math.max(0, iy);
  }

  // 모든 waypoint의 핀 존 (마커 유닛이 침범하면 안 되는 영역)
  const allPinZones = pts.map(pinZone);

  // 배지 장애물 존 (26×26px 배지 기준, 여유 포함)
  const BADGE_R = 16;
  const allBadgeZones = badgePts.map(pt => ({
    x: pt.x - BADGE_R, y: pt.y - BADGE_R, w: BADGE_R * 2, h: BADGE_R * 2,
  }));

  const DIRS = [[0,-1],[0.71,-0.71],[1,0],[0.71,0.71],[0,1],[-0.71,0.71],[-1,0],[-0.71,-0.71]];
  const candidates = DIRS.flatMap(([dx, dy]) =>
    [55, 90, 130].map(d => ({ dx: Math.round(dx * d), dy: Math.round(dy * d) }))
  );

  const offsets = pts.map(() => ({ dx: 0, dy: 0 }));
  const placed = []; // 이미 배치된 마커 유닛 bboxes

  for (let i = 0; i < pts.length; i++) {
    const nat = bbox(i, 0, 0);

    // 자연 위치에서의 충돌: 다른 유닛 bbox + 다른 waypoint 핀 존 + 배지 존
    const natConflict =
      placed.some(b => overlaps(nat, b)) ||
      allPinZones.some((pz, pi) => pi !== i && overlaps(nat, pz)) ||
      allBadgeZones.some(bz => overlaps(nat, bz));

    if (!natConflict) {
      placed.push(nat);
    } else {
      let best = { dx: 0, dy: 0 }, bestScore = Infinity;
      for (const c of candidates) {
        const tb = bbox(i, c.dx, c.dy);
        // 페널티: 다른 유닛 겹침 + 다른 핀 존 겹침 + 배지 겹침
        const unitOverlap  = placed.reduce((s, b) => s + overlapArea(tb, b), 0);
        const pinOverlap   = allPinZones
          .filter((_, pi) => pi !== i)
          .reduce((s, pz) => s + overlapArea(tb, pz), 0);
        const badgeOverlap = allBadgeZones.reduce((s, bz) => s + overlapArea(tb, bz), 0);
        const score = unitOverlap * 100 + pinOverlap * 200 + badgeOverlap * 150 + Math.hypot(c.dx, c.dy);
        if (score < bestScore) { bestScore = score; best = c; }
      }
      offsets[i] = best;
      placed.push(bbox(i, best.dx, best.dy));
    }
  }
  return offsets;
}

// ─── 마커 DivIcon 생성 ───────────────────────────────────────
function makeMarkerIcon(wp, i, offset = { dx: 0, dy: 0 }, numLabel = null) {
  const { dx, dy } = offset;
  const hasOffset = dx !== 0 || dy !== 0;
  const hasImg = !!wp.imgUrl;
  const bgStyle = hasImg ? `style="background-image:url(${wp.imgUrl})"` : '';
  const placeholder = !hasImg
    ? `<svg width="24" height="24" viewBox="0 0 24 24" fill="#ccc"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>`
    : '';
  const displayNum = numLabel != null ? numLabel : String(i + 1);
  const numHtml = showCourse ? `<span class="pm-num">${displayNum}</span>` : '';
  const pill = `<div class="pm-pill${showCourse ? '' : ' pm-pill--nonum'}">${numHtml}<span class="pm-name">${wp.name}</span></div>`;

  let inner = '';
  if (hasOffset) {
    // 리더 라인만 포함 (pin 도트는 별도 마커로 렌더링 → 항상 모든 유닛 아래)
    const len = Math.hypot(dx, dy).toFixed(1);
    const ang = (Math.atan2(dy, dx) * 180 / Math.PI).toFixed(1);
    inner += `<div class="pm-leader-line" style="width:${len}px;transform:rotate(${ang}deg)"></div>`;
  }
  const scaleStr = markerScale !== 1 ? ` scale(${markerScale})` : '';
  const unitTransform = showPhoto ? `translate(-50%,-32px)${scaleStr}` : `translate(-50%,-50%)${scaleStr}`;
  inner += `<div class="pm-unit" style="left:${dx}px;top:${dy}px;transform:${unitTransform}">`;
  if (showPhoto) inner += `<div class="pm-photo" ${bgStyle}>${placeholder}</div>`;
  inner += pill + `</div>`;

  return L.divIcon({
    html: `<div class="pm-root">${inner}</div>`,
    className: '',
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

// ─── 곡선 유틸: lat/lng 기반 quadratic bezier arc ────────────
// 줌 레벨에 의존하지 않고 lat/lng 좌표 공간에서 직접 곡선 계산
// side: 1 = 왼쪽 볼록, -1 = 오른쪽 볼록
function getArcLatLngs(aLat, aLng, bLat, bLng, side = 1, segments = 30) {
  const dx = bLng - aLng, dy = bLat - aLat;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.0001) return [[aLat, aLng], [bLat, bLng]];
  const offset = dist * 0.25; // 두 점 거리의 25% 오프셋
  const nx = (-dy / dist) * side, ny = (dx / dist) * side;
  const cLng = (aLng + bLng) / 2 + ny * offset;
  const cLat = (aLat + bLat) / 2 + nx * offset;
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const lat = (1 - t) * (1 - t) * aLat + 2 * (1 - t) * t * cLat + t * t * bLat;
    const lng = (1 - t) * (1 - t) * aLng + 2 * (1 - t) * t * cLng + t * t * bLng;
    points.push([lat, lng]);
  }
  return points;
}

// 곡선 위 t 지점의 lat/lng + 접선 방향(bearing) 반환
function getArcPointAt(aLat, aLng, bLat, bLng, t, side = 1) {
  const dx = bLng - aLng, dy = bLat - aLat;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.0001) return { lat: (aLat + bLat) / 2, lng: (aLng + bLng) / 2, bearing: 0 };
  const offset = dist * 0.25;
  const nx = (-dy / dist) * side, ny = (dx / dist) * side;
  const cLng = (aLng + bLng) / 2 + ny * offset;
  const cLat = (aLat + bLat) / 2 + nx * offset;
  // 곡선 위 점
  const lat = (1 - t) * (1 - t) * aLat + 2 * (1 - t) * t * cLat + t * t * bLat;
  const lng = (1 - t) * (1 - t) * aLng + 2 * (1 - t) * t * cLng + t * t * bLng;
  // 접선 (미분) → bearing 계산
  const tLat = 2 * (1 - t) * (cLat - aLat) + 2 * t * (bLat - cLat);
  const tLng = 2 * (1 - t) * (cLng - aLng) + 2 * t * (bLng - cLng);
  const bearing = (Math.atan2(tLng, tLat) * 180 / Math.PI + 360) % 360;
  return { lat, lng, bearing };
}

// ─── 방향 화살표: pixel space 보간으로 zoom-independent 배치 ──
// 문제: lat/lng 선형보간 ≠ Mercator 화면 선형. 줌인 시 화살표가 경로선에서 벗어남.
// 해결: map.project()로 픽셀 좌표 변환 후 보간 → unproject로 lat/lng 복원.
//       zoomend마다 재계산해서 항상 선 위에 정확하게 위치.
function updateArrows() {
  arrowLayer.clearLayers();
  if (waypoints.length < 2) return;
  const zoom = map.getZoom();
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i], b = waypoints[i + 1];
    // badgeSegments에 curved 정보가 있으면 활용
    const seg = badgeSegments[i];
    const useCurve = seg ? seg.curved : (isLoop ? 1 : 0);
    if (useCurve) {
      [0.25, 0.75].forEach((t) => {
        const pt = getArcPointAt(a.lat, a.lng, b.lat, b.lng, t, useCurve);
        L.marker([pt.lat, pt.lng], {
          icon: makeArrowIcon(pt.bearing),
          interactive: false, zIndexOffset: -200,
        }).addTo(arrowLayer);
      });
    } else {
      const bearing = calcBearing(a, b);
      const pA = map.project([a.lat, a.lng], zoom);
      const pB = map.project([b.lat, b.lng], zoom);
      [0.25, 0.75].forEach((t) => {
        const latlng = map.unproject(
          L.point(pA.x + t * (pB.x - pA.x), pA.y + t * (pB.y - pA.y)), zoom
        );
        L.marker(latlng, {
          icon: makeArrowIcon(bearing),
          interactive: false, zIndexOffset: -200,
        }).addTo(arrowLayer);
      });
    }
  }
  // isLoop 닫힘 화살표 (돌아오는길 — a/b 스왑으로 자연 반대쪽)
  if (isLoop && waypoints.length >= 2) {
    const a = waypoints[waypoints.length - 1], b = waypoints[0];
    [0.25, 0.75].forEach((t) => {
      const pt = getArcPointAt(a.lat, a.lng, b.lat, b.lng, t, 1);
      L.marker([pt.lat, pt.lng], {
        icon: makeArrowIcon(pt.bearing),
        interactive: false, zIndexOffset: -200,
      }).addTo(arrowLayer);
    });
  }
}
// ─── renderMarkers (deconfliction 포함, zoomend에서도 호출) ──
let _markerRenderTimer = null;
function renderMarkers() {
  markerLayer.clearLayers();
  if (waypoints.length === 0) return;

  // 동일 위치 waypoint를 그룹핑 (이름 + 근접 좌표 기준)
  const groups = []; // [{ wp, indices: [0,2,...], lat, lng }]
  const assigned = new Array(waypoints.length).fill(false);
  for (let i = 0; i < waypoints.length; i++) {
    if (assigned[i]) continue;
    const g = { wp: waypoints[i], indices: [i], lat: waypoints[i].lat, lng: waypoints[i].lng };
    for (let j = i + 1; j < waypoints.length; j++) {
      if (assigned[j]) continue;
      if (waypoints[j].name === waypoints[i].name && Math.hypot(waypoints[j].lat - waypoints[i].lat, waypoints[j].lng - waypoints[i].lng) < 0.002) {
        g.indices.push(j);
        assigned[j] = true;
        // 이미지가 있는 wp 우선
        if (!g.wp.imgUrl && waypoints[j].imgUrl) g.wp = waypoints[j];
      }
    }
    assigned[i] = true;
    groups.push(g);
  }

  const pts = groups.map(g => map.latLngToContainerPoint([g.lat, g.lng]));
  const badgePts = (showBadge && showCourse)
    ? badgeSegments.map(s => map.latLngToContainerPoint([s.midLat, s.midLng]))
    : [];
  const offsets = computeOffsets(pts, badgePts);

  // 패스 1: 핀 도트
  groups.forEach((g, gi) => {
    const { dx, dy } = offsets[gi];
    if (dx !== 0 || dy !== 0) {
      L.marker([g.lat, g.lng], {
        icon: L.divIcon({
          html: '<div class="pm-pin"></div>',
          className: '',
          iconSize: [0, 0],
          iconAnchor: [0, 0],
        }),
        zIndexOffset: -2000,
        interactive: false,
      }).addTo(markerLayer);
    }
  });

  // 패스 2: 유닛 (그룹핑된 번호 표시)
  groups.forEach((g, gi) => {
    const numLabel = g.indices.map(idx => idx + 1).join(' · ');
    L.marker([g.lat, g.lng], {
      icon: makeMarkerIcon(g.wp, g.indices[0], offsets[gi], numLabel),
      zIndexOffset: 500 + g.indices[0] * 10,
    }).addTo(markerLayer);
  });
}

// zoom/pan이 끝날 때마다 화살표 재계산 + 마커 deconfliction + 배지 충돌 재계산
map.on('zoomend', () => {
  updateArrows();
  clearTimeout(_markerRenderTimer);
  _markerRenderTimer = setTimeout(() => { renderMarkers(); renderBadges(); }, 80);
});

// ─── Badge segments 캐시 (zoomend에서 재평가용) ───────────────
let badgeSegments = []; // [{ aLat, aLng, bLat, bLng, midLat, midLng, mode }]

// 배지는 항상 세그먼트 정중앙에 배치 (마커 pill이 배지를 피해서 이동)
function renderBadges() {
  badgeLayer.clearLayers();
  if (!showBadge || !showCourse || !map.hasLayer(badgeLayer)) return;

  badgeSegments.forEach(({ midLat, midLng, mode, modeKey }) => {
    if (modeKey && !visibleModes[modeKey]) return;
    L.marker([midLat, midLng], {
      icon: L.divIcon({
        html: `<div class="transport-badge">${makeSvgHtml(mode, 14)}</div>`,
        className: '',
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
      interactive: false,
      zIndexOffset: -100,
    }).addTo(badgeLayer);
  });
}

function updateBadgeUI() {
  const anyHidden = Object.values(visibleModes).some(v => !v);
  document.getElementById('badge-filter-dot').style.display = anyHidden ? 'inline-block' : 'none';
  document.querySelectorAll('.mode-chip').forEach(chip => {
    chip.classList.toggle('active', !!visibleModes[chip.dataset.mode]);
  });
}

// ─── Render ──────────────────────────────────────────────────
function render() {
  saveState();
  polylineLayer.clearLayers();
  badgeLayer.clearLayers();
  arrowLayer.clearLayers();
  markerLayer.clearLayers();
  badgeSegments = [];

  // 코스 레이어 (폴리라인 + 화살표) 동기화
  if (showCourse && !map.hasLayer(polylineLayer)) polylineLayer.addTo(map);
  if (!showCourse && map.hasLayer(polylineLayer)) map.removeLayer(polylineLayer);
  if (showCourse && !map.hasLayer(arrowLayer)) arrowLayer.addTo(map);
  if (!showCourse && map.hasLayer(arrowLayer)) map.removeLayer(arrowLayer);

  // 배지 레이어: showBadge AND showCourse 둘 다 켜져야 표시
  const showBadgeLayer = showBadge && showCourse;
  if (showBadgeLayer && !map.hasLayer(badgeLayer)) badgeLayer.addTo(map);
  if (!showBadgeLayer && map.hasLayer(badgeLayer)) map.removeLayer(badgeLayer);

  // 겹치는 세그먼트 감지: 이전 세그먼트와 역방향으로 겹치면 곡선 처리
  // (A→B가 있는데 B→A가 나오면 둘 다 곡선)
  const segKeys = new Set();
  const overlapSet = new Set();
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i], b = waypoints[i + 1];
    const fwd = `${a.name}→${b.name}`;
    const rev = `${b.name}→${a.name}`;
    if (segKeys.has(rev) || segKeys.has(fwd)) {
      overlapSet.add(fwd);
      overlapSet.add(rev);
    }
    segKeys.add(fwd);
  }
  const needsCurve = isLoop || overlapSet.size > 0;

  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    const modeKey = transportModes[i] || 'bus';
    const mode = TRANSPORT[modeKey];
    const segKey = `${a.name}→${b.name}`;
    const useCurve = isLoop || overlapSet.has(segKey);

    if (useCurve) {
      // 곡선 (side=1: 가는길)
      const arcPoints = getArcLatLngs(a.lat, a.lng, b.lat, b.lng, 1);
      L.polyline(arcPoints, {
        renderer: canvasRenderer, color: '#222', weight: 2.5, opacity: 0.8,
        dashArray: showBadge ? (mode.dashArray || undefined) : undefined,
      }).addTo(polylineLayer);
      const arcMid = getArcPointAt(a.lat, a.lng, b.lat, b.lng, 0.5, 1);
      badgeSegments.push({ aLat: a.lat, aLng: a.lng, bLat: b.lat, bLng: b.lng, midLat: arcMid.lat, midLng: arcMid.lng, mode, modeKey, curved: 1 });
    } else {
      // 직선
      L.polyline([[a.lat, a.lng], [b.lat, b.lng]], {
        renderer: canvasRenderer, color: '#222', weight: 2.5, opacity: 0.8,
        dashArray: showBadge ? (mode.dashArray || undefined) : undefined,
      }).addTo(polylineLayer);
      const midLat = (a.lat + b.lat) / 2;
      const midLng = (a.lng + b.lng) / 2;
      badgeSegments.push({ aLat: a.lat, aLng: a.lng, bLat: b.lat, bLng: b.lng, midLat, midLng, mode, modeKey, curved: 0 });
    }
  }

  // isLoop: 마지막 → 첫 번째 닫힘 세그먼트 (돌아오는길)
  if (isLoop && waypoints.length >= 2) {
    const a = waypoints[waypoints.length - 1], b = waypoints[0];
    const mode = TRANSPORT[loopTransportMode] || TRANSPORT.bus;
    const arcPoints = getArcLatLngs(a.lat, a.lng, b.lat, b.lng, 1);
    L.polyline(arcPoints, {
      renderer: canvasRenderer, color: '#222', weight: 2.5, opacity: 0.8,
      dashArray: showBadge ? (mode.dashArray || undefined) : undefined,
    }).addTo(polylineLayer);
    const arcMid = getArcPointAt(a.lat, a.lng, b.lat, b.lng, 0.5, 1);
    badgeSegments.push({ aLat: a.lat, aLng: a.lng, bLat: b.lat, bLng: b.lng, midLat: arcMid.lat, midLng: arcMid.lng, mode, modeKey: loopTransportMode });
  }

  // 번호/사진 마커 (deconfliction 포함)
  renderMarkers();
  // 배지: 마커 위치 확정 후 화면 좌표 기준 충돌 체크
  renderBadges();

  if (waypoints.length >= 2) {
    // fitBounds 애니메이션 완료 후 화살표 위치 계산
    map.once('moveend', updateArrows);
    map.fitBounds(L.latLngBounds(waypoints.map((wp) => [wp.lat, wp.lng])), {
      padding: [60, 80],
    });
  } else if (waypoints.length === 1) {
    map.setView([waypoints[0].lat, waypoints[0].lng], 8);
    updateArrows();
  } else {
    updateArrows();
  }

  renderSidebar();
}

// ─── Sidebar ─────────────────────────────────────────────────
function renderSidebar() {
  const list = document.getElementById('course-list');
  document.getElementById('edit-toggle')?.classList.toggle('active', isEditMode);

  if (waypoints.length === 0) {
    list.innerHTML = `<div class="empty-state"><span class="empty-icon">🗺️</span>장소를 검색해서<br>코스를 추가해보세요</div>`;
    return;
  }

  list.innerHTML = '';
  waypoints.forEach((wp, i) => {
    const item = document.createElement('div');
    item.className = 'course-item';
    item.draggable = true;
    item.dataset.index = i;
    const dragDots = `
      <div class="drag-handle">
        <svg width="8" height="12" viewBox="0 0 8 12" fill="none">
          <circle cx="2" cy="2"  r="1.5" fill="#ccc"/>
          <circle cx="6" cy="2"  r="1.5" fill="#ccc"/>
          <circle cx="2" cy="6"  r="1.5" fill="#ccc"/>
          <circle cx="6" cy="6"  r="1.5" fill="#ccc"/>
          <circle cx="2" cy="10" r="1.5" fill="#ccc"/>
          <circle cx="6" cy="10" r="1.5" fill="#ccc"/>
        </svg>
      </div>`;

    const numOrPhoto = showPhoto
      ? `<div class="course-photo-btn" data-i="${i}" title="클릭하여 사진 변경">
           <div class="course-thumb" ${wp.imgUrl ? `style="background-image:url(${wp.imgUrl})"` : ''}>
             ${!wp.imgUrl ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="#bbb"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>` : ''}
             <span class="course-thumb-num">${i + 1}</span>
           </div>
         </div>`
      : `<div class="course-number">${i + 1}</div>`;

    const nameEl = isEditMode
      ? `<input class="course-name-input" data-i="${i}" value="${escapeHtml(wp.name)}" maxlength="30">`
      : `<div class="course-name">${escapeHtml(wp.name)}</div>`;
    item.innerHTML = `${dragDots}${numOrPhoto}${nameEl}
      <button class="course-delete" data-i="${i}" title="삭제">×</button>`;

    // ── 드래그 앤 드롭 이벤트 ──────────────────────────────
    item.addEventListener('dragstart', (e) => {
      dragSrcIndex = i;
      e.dataTransfer.effectAllowed = 'move';
      // 브라우저가 drag ghost 스냅샷 찍은 뒤 스타일 적용
      setTimeout(() => item.classList.add('dragging'), 0);
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      list.querySelectorAll('.course-item').forEach((el) => el.classList.remove('drag-over'));
      dragSrcIndex = null;
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragSrcIndex !== null && dragSrcIndex !== i) {
        list.querySelectorAll('.course-item').forEach((el) => el.classList.remove('drag-over'));
        item.classList.add('drag-over');
      }
    });

    item.addEventListener('dragleave', (e) => {
      // 자식 요소로 이동할 때 불필요한 dragleave 무시
      if (!item.contains(e.relatedTarget)) item.classList.remove('drag-over');
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.classList.remove('drag-over');
      if (dragSrcIndex === null || dragSrcIndex === i) return;

      // 순서 변경: waypoint 이동
      const [moved] = waypoints.splice(dragSrcIndex, 1);
      waypoints.splice(i, 0, moved);
      // 교통수단은 세그먼트 수(N-1) 유지, 새 위치에 맞게 재정렬
      const prevModes = [...transportModes];
      transportModes = Array.from({ length: waypoints.length - 1 }, (_, idx) => prevModes[idx] || 'bus');
      isLoop = false; // 드래그 재정렬 시 루프 해제 (첫/마지막 관계 변동 가능)
      render();
    });

    list.appendChild(item);

    if (i < waypoints.length - 1) {
      const modeKey = transportModes[i] || 'bus';
      const connector = document.createElement('div');
      connector.className = 'transport-connector';
      connector.innerHTML = `
        <div class="connector-line"></div>
        <select class="transport-select" data-i="${i}">
          ${Object.entries(TRANSPORT)
            .map(
              ([key, val]) =>
                `<option value="${key}" ${key === modeKey ? 'selected' : ''}>${val.label}</option>`
            )
            .join('')}
        </select>`;
      list.appendChild(connector);
    }
  });

  // ── isLoop: 닫힘 세그먼트 (마지막 → 출발지) 패널 표시 ──
  if (isLoop && waypoints.length >= 2) {
    // 닫힘 구간 이동수단 셀렉터
    const loopConnector = document.createElement('div');
    loopConnector.className = 'transport-connector';
    loopConnector.innerHTML = `
      <div class="connector-line"></div>
      <select class="transport-select" data-loop="true">
        ${Object.entries(TRANSPORT)
          .map(
            ([key, val]) =>
              `<option value="${key}" ${key === loopTransportMode ? 'selected' : ''}>${val.label}</option>`
          )
          .join('')}
      </select>`;
    list.appendChild(loopConnector);

    // 출발지(도착) 표시
    const first = waypoints[0];
    const loopItem = document.createElement('div');
    loopItem.className = 'course-item course-item-loop';
    const loopNum = waypoints.length + 1;
    const loopNumOrPhoto = showPhoto
      ? `<div class="course-photo-btn" data-i="0" title="클릭하여 사진 변경">
           <div class="course-thumb" ${first.imgUrl ? `style="background-image:url(${first.imgUrl})"` : ''}>
             ${!first.imgUrl ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="#bbb"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>` : ''}
             <span class="course-thumb-num">${loopNum}</span>
           </div>
         </div>`
      : `<div class="course-number">${loopNum}</div>`;
    loopItem.innerHTML = `
      <div class="drag-handle" style="visibility:hidden">
        <svg width="8" height="12" viewBox="0 0 8 12" fill="none"></svg>
      </div>
      ${loopNumOrPhoto}
      <div class="course-name">${escapeHtml(first.name)}</div>
      <button class="course-loop-remove" title="루프 해제">×</button>`;
    list.appendChild(loopItem);

    list.querySelector('.course-loop-remove')?.addEventListener('click', () => {
      isLoop = false;
      render();
    });

    list.querySelector('[data-loop="true"]')?.addEventListener('change', (e) => {
      loopTransportMode = e.target.value;
      render();
    });
  }

  list.querySelectorAll('.course-photo-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      openPhotoPicker(parseInt(btn.dataset.i, 10));
    });
  });

  list.querySelectorAll('.course-delete').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.i, 10);
      waypoints.splice(idx, 1);
      if (transportModes.length >= waypoints.length)
        transportModes.splice(Math.min(idx, transportModes.length - 1), 1);
      isLoop = false; // 삭제 시 루프 해제
      render();
    });
  });

  list.querySelectorAll('.transport-select').forEach((sel) => {
    sel.addEventListener('change', () => {
      transportModes[parseInt(sel.dataset.i, 10)] = sel.value;
      render();
    });
  });

  // 편집 모드: 이름 input 저장
  list.querySelectorAll('.course-name-input').forEach((input) => {
    const saveName = () => {
      const idx = parseInt(input.dataset.i, 10);
      const newName = input.value.trim();
      if (newName && newName !== waypoints[idx].name) {
        waypoints[idx].name = newName;
        renderMarkers();
        saveState();
      }
    };
    input.addEventListener('blur', saveName);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = waypoints[parseInt(input.dataset.i, 10)].name; input.blur(); }
    });
  });
}

// ─── Search ──────────────────────────────────────────────────
const searchInput   = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
const searchSpinner = document.getElementById('search-spinner');
let searchTimer = null;

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) { closeResults(); return; }
  searchTimer = setTimeout(() => doSearch(q), 400);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeResults();
  if (e.key === 'Enter') {
    const first = searchResults.querySelector('.search-result-item:not(.no-result)');
    if (first) first.click();
  }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#search-section')) closeResults();
});

function closeResults() {
  searchResults.classList.remove('visible');
  searchResults.innerHTML = '';
}

// CamelCase에 공백 삽입 + 연속 공백 정리 (예: "LasVegas" → "Las Vegas")
function normalizeQuery(q) {
  return q
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

// 비라틴 문자(한글·한자·일어 등) 포함 여부
function hasNonLatin(q) {
  return /[\u0100-\uFFFF]/.test(q);
}

// Nominatim 검색 (기존 엔진)
async function nominatimSearch(query) {
  const url =
    `https://nominatim.openstreetmap.org/search` +
    `?q=${encodeURIComponent(query)}&format=json&limit=6&accept-language=ko,en&namedetails=1`;
  const res = await fetch(url, { headers: NOMINATIM_HEADERS });
  if (!res.ok) return [];
  const data = await res.json();
  return data.map(p => ({
    lat: p.lat,
    lon: p.lon,
    display_name: p.display_name,
    namedetails: p.namedetails,
    _source: 'nominatim',
  }));
}

// Photon 검색 (Komoot, 무료/무키, 다국어 매칭 강함)
async function photonSearch(query) {
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=6&lang=en`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.features || []).map(f => {
    const p = f.properties;
    const nameParts = [p.name, p.city || p.county, p.state, p.country].filter(Boolean);
    return {
      lat: String(f.geometry.coordinates[1]),
      lon: String(f.geometry.coordinates[0]),
      display_name: nameParts.join(', '),
      namedetails: { 'name:en': p.name },
      _source: 'photon',
    };
  }).filter(r => r.display_name);
}

async function doSearch(query) {
  const normalized = normalizeQuery(query);
  searchSpinner.classList.remove('hidden');
  try {
    // 1차: 정규화된 쿼리로 Nominatim 검색
    let results = await nominatimSearch(normalized);

    // 2차: 결과 없고 비라틴 문자(한글 등) → Photon fallback
    if (results.length === 0 && hasNonLatin(normalized)) {
      results = await photonSearch(normalized);
    }

    // 3차: 여전히 없고 원본과 정규화 쿼리가 다르면 → 원본으로 한번 더
    if (results.length === 0 && normalized !== query) {
      results = await nominatimSearch(query);
    }

    searchResults.innerHTML = '';
    if (results.length === 0) {
      const hint = hasNonLatin(normalized)
        ? '검색 결과가 없습니다. 영어로도 검색해보세요 (예: Las Vegas)'
        : '검색 결과가 없습니다';
      searchResults.innerHTML = `<div class="search-result-item no-result">${hint}</div>`;
    } else {
      results.forEach((place) => {
        const parts  = place.display_name.split(',');
        const name   = parts[0].trim();
        const region = parts.slice(1, 3).join(',').trim();
        const el = document.createElement('div');
        el.className = 'search-result-item';
        el.innerHTML = `<strong>${escapeHtml(name)}</strong>${region ? `<br><span style="color:#aaa;font-size:11px">${escapeHtml(region)}</span>` : ''}`;
        el.addEventListener('click', () => {
          const wikiName = place.namedetails?.['name:en'] || name;
          addWaypoint(name, parseFloat(place.lat), parseFloat(place.lon), wikiName);
        });
        searchResults.appendChild(el);
      });
    }
    searchResults.classList.add('visible');
  } catch {
    searchResults.innerHTML = '<div class="search-result-item no-result">검색 중 오류가 발생했습니다</div>';
    searchResults.classList.add('visible');
  } finally {
    searchSpinner.classList.add('hidden');
  }
}

function addWaypoint(name, lat, lng, wikiName = null) {
  // 루프가 활성 상태에서 새 장소를 추가하면 → 루프를 실체화(첫 waypoint를 끝에 복제)한 뒤 이어 붙임
  if (isLoop) {
    const first = waypoints[0];
    // 같은 장소를 또 추가하는 건 무시
    if (Math.hypot(first.lat - lat, first.lng - lng) < 0.01 || first.name === name) {
      searchInput.value = '';
      closeResults();
      return;
    }
    // 루프 닫기 세그먼트를 실제 waypoint로 변환
    waypoints.push({ name: first.name, lat: first.lat, lng: first.lng, wikiName: first.wikiName, imgUrl: first.imgUrl });
    transportModes.push(loopTransportMode);
    isLoop = false;
    loopTransportMode = null;
    // 이후 아래에서 새 waypoint가 push됨
  }

  // 루프 감지: 2개 이상이고 첫 waypoint와 매우 가깝거나 이름이 같으면 닫힘 세그먼트만 추가
  if (waypoints.length >= 2) {
    const first = waypoints[0];
    if (Math.hypot(first.lat - lat, first.lng - lng) < 0.01 || first.name === name) {
      isLoop = true;
      loopTransportMode = transportModes[transportModes.length - 1] || 'bus';
      searchInput.value = '';
      closeResults();
      render();
      return;
    }
  }
  waypoints.push({ name, lat, lng, wikiName: wikiName || name, imgUrl: null });
  if (waypoints.length > 1) transportModes.push('bus');
  searchInput.value = '';
  closeResults();
  render();
  if (showPhoto) {
    const idx = waypoints.length - 1;
    fetchLocationImage(waypoints[idx].wikiName, waypoints[idx].lat, waypoints[idx].lng).then((url) => {
      if (url && waypoints[idx]) {
        waypoints[idx].imgUrl = url;
        render();
      }
    });
  }
}

// ─── Photo toggle ────────────────────────────────────────────
document.getElementById('photo-toggle').addEventListener('click', () => {
  showPhoto = !showPhoto;
  document.getElementById('photo-toggle').classList.toggle('active', showPhoto);
  if (showPhoto) loadMissingImages(); // 이미지 없는 waypoint 자동 로딩
  render();
});

// 파일 업로드 (사이드바 썸네일 클릭 → 로컬 이미지로 교체)
document.getElementById('photo-upload-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file || uploadTargetIndex === null) return;
  const targetIdx = uploadTargetIndex; // 비동기 onload 전에 캡처
  const reader = new FileReader();
  reader.onload = (ev) => {
    const url = ev.target.result;
    waypoints[targetIdx].imgUrl = url;
    preloadWpImage(url);
    render();
  };
  reader.readAsDataURL(file);
  e.target.value = '';
  uploadTargetIndex = null;
});

// ─── Scale control ───────────────────────────────────────────
document.querySelectorAll('.scale-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    markerScale = parseFloat(btn.dataset.scale);
    document.querySelectorAll('.scale-btn').forEach(b =>
      b.classList.toggle('active', b === btn)
    );
    renderMarkers();
    saveState();
  });
});

// ─── Course toggle ───────────────────────────────────────────
document.getElementById('course-toggle').addEventListener('click', () => {
  showCourse = !showCourse;
  document.getElementById('course-toggle').classList.toggle('active', showCourse);

  if (showCourse && !map.hasLayer(polylineLayer)) polylineLayer.addTo(map);
  if (!showCourse && map.hasLayer(polylineLayer)) map.removeLayer(polylineLayer);
  if (showCourse && !map.hasLayer(arrowLayer)) arrowLayer.addTo(map);
  if (!showCourse && map.hasLayer(arrowLayer)) map.removeLayer(arrowLayer);

  const showBadgeLayer = showBadge && showCourse;
  if (showBadgeLayer && !map.hasLayer(badgeLayer)) badgeLayer.addTo(map);
  if (!showBadgeLayer && map.hasLayer(badgeLayer)) map.removeLayer(badgeLayer);

  renderMarkers(); // 번호 원 표시 여부 반영
  saveState();
});

// ─── Badge toggle ────────────────────────────────────────────
document.getElementById('badge-toggle').addEventListener('click', () => {
  showBadge = !showBadge;
  document.getElementById('badge-toggle').classList.toggle('active', showBadge);
  // 폴리라인 dashArray 반영을 위해 전체 재렌더
  render();
});

// ─── Badge filter (popover + mode chips) ─────────────────────
// 팝오버에 이동수단 칩 동적 생성
(function() {
  const popover = document.getElementById('badge-filter-popover');
  Object.entries(TRANSPORT).forEach(([key, t]) => {
    const chip = document.createElement('button');
    chip.className = 'mode-chip active';
    chip.dataset.mode = key;
    chip.innerHTML = `${makeSvgHtml(t, 14)}<span>${t.label}</span>`;
    popover.appendChild(chip);
  });
})();

// 호버로 팝오버 열기/닫기
(function() {
  let hideTimer = null;
  const split = document.getElementById('badge-toggle');
  const popover = document.getElementById('badge-filter-popover');

  function showPopover() {
    clearTimeout(hideTimer);
    popover.classList.add('visible');
  }
  function hidePopover() {
    hideTimer = setTimeout(() => popover.classList.remove('visible'), 120);
  }

  split.addEventListener('mouseenter', showPopover);
  split.addEventListener('mouseleave', hidePopover);
  popover.addEventListener('mouseenter', showPopover);
  popover.addEventListener('mouseleave', hidePopover);
})();

document.getElementById('badge-filter-popover').addEventListener('click', (e) => {
  const chip = e.target.closest('.mode-chip');
  if (!chip) return;
  visibleModes[chip.dataset.mode] = !visibleModes[chip.dataset.mode];
  updateBadgeUI();
  renderBadges();
  renderMarkers();
  saveState();
});

// ─── Edit toggle ─────────────────────────────────────────────
document.getElementById('edit-toggle').addEventListener('click', () => {
  isEditMode = !isEditMode;
  renderSidebar();
});

// ─── Pin mode ─────────────────────────────────────────────────
function enterPinMode() {
  isPinMode = true;
  document.getElementById('pin-toggle').classList.add('active');
  document.getElementById('map').classList.add('pin-mode');
  document.getElementById('pin-mode-hint').classList.add('visible');
}

function exitPinMode() {
  isPinMode = false;
  document.getElementById('pin-toggle').classList.remove('active');
  document.getElementById('map').classList.remove('pin-mode');
  document.getElementById('pin-mode-hint').classList.remove('visible');
  if (pinMarker && map.hasLayer(pinMarker)) map.removeLayer(pinMarker);
  pinMarker = null;
  map.closePopup();
}

document.getElementById('pin-toggle').addEventListener('click', () => {
  isPinMode ? exitPinMode() : enterPinMode();
});

// Esc로 핀 모드 취소
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isPinMode) exitPinMode();
});

// 지도 클릭 → 핀 모드일 때만 팝업 열기
map.on('click', (e) => {
  if (!isPinMode) return;

  const { lat, lng } = e.latlng;

  // 이전 임시 마커 제거
  if (pinMarker && map.hasLayer(pinMarker)) map.removeLayer(pinMarker);
  map.closePopup();

  // 임시 마커 생성
  pinMarker = L.circleMarker([lat, lng], {
    radius: 8,
    color: '#fff',
    fillColor: '#E85D26',
    fillOpacity: 1,
    weight: 2.5,
  }).addTo(map);

  // 팝업 컨텐츠
  const popupContent = `
    <div class="pin-popup-form">
      <div class="pin-popup-label">장소명을 입력하세요</div>
      <input class="pin-popup-input" type="text" placeholder="예: 몬세라트 시체스" maxlength="40">
      <div class="pin-popup-actions">
        <button class="pin-cancel-btn">취소</button>
        <button class="pin-confirm-btn">추가하기</button>
      </div>
    </div>
  `;

  L.popup({ closeButton: false, className: 'pin-popup', offset: [0, -10] })
    .setLatLng([lat, lng])
    .setContent(popupContent)
    .openOn(map);

  // 팝업 DOM 렌더링 후 이벤트 바인딩
  setTimeout(() => {
    const input = document.querySelector('.pin-popup-input');
    const confirmBtn = document.querySelector('.pin-confirm-btn');
    const cancelBtn = document.querySelector('.pin-cancel-btn');
    if (!input) return;

    input.focus();

    const confirmAdd = () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      addWaypoint(name, lat, lng, name);
      exitPinMode();
    };

    confirmBtn.addEventListener('click', confirmAdd);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); confirmAdd(); }
      if (ev.key === 'Escape') { ev.stopPropagation(); exitPinMode(); }
    });
    cancelBtn.addEventListener('click', () => exitPinMode());
  }, 50);
});

// ─── Clear ────────────────────────────────────────────────────
document.getElementById('clear-btn').addEventListener('click', () => {
  if (waypoints.length === 0) return;
  if (!confirm('모든 코스를 초기화할까요?')) return;
  waypoints = []; transportModes = []; isLoop = false; loopTransportMode = 'bus';
  localStorage.removeItem(STORAGE_KEY);
  render();
  map.fitBounds([[-75, -165], [75, 165]]);
});

// ─── Export (순수 Canvas API – html2canvas 제거) ─────────────
// html2canvas는 Leaflet SVG 레이어를 캡처 못함.
// 대신: Leaflet canvas pane을 직접 복사 + 마커/라벨을 Canvas 2D로 수동 드로잉.
const exportOverlay = document.getElementById('export-overlay');

function drawRoundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

document.getElementById('export-btn').addEventListener('click', async () => {
  if (waypoints.length === 0) { alert('코스를 먼저 추가해주세요!'); return; }

  exportOverlay.classList.add('visible');
  await new Promise((r) => setTimeout(r, 1200)); // 타일 로딩 완료 대기

  try {
    const mapEl = document.getElementById('map');
    const W = mapEl.clientWidth;
    const H = mapEl.clientHeight;
    const SCALE = 2; // 2× 고해상도 (SNS 용)

    const out = document.createElement('canvas');
    out.width  = W * SCALE;
    out.height = H * SCALE;
    const ctx  = out.getContext('2d');
    ctx.scale(SCALE, SCALE);

    // 1. 배경 (타일 미로딩 fallback)
    ctx.fillStyle = '#C5DDE8';
    ctx.fillRect(0, 0, W, H);

    // 2. 지형 타일 이미지 캡처 (CartoDB Voyager – crossOrigin:true로 CORS 허용)
    // getBoundingClientRect()로 transform 포함 실제 화면 위치 계산
    const mapRect = mapEl.getBoundingClientRect();
    mapEl.querySelectorAll('.leaflet-tile-pane img.leaflet-tile').forEach((img) => {
      if (!img.complete || !img.naturalWidth) return;
      try {
        const r = img.getBoundingClientRect();
        ctx.drawImage(img, r.left - mapRect.left, r.top - mapRect.top, r.width, r.height);
      } catch (e) {
        console.warn('Tile draw failed:', e);
      }
    });

    // 3. Leaflet 벡터 캔버스 (경계선 + 폴리라인)
    const leafCanvas = mapEl.querySelector('canvas.leaflet-zoom-animated');
    if (leafCanvas) {
      ctx.drawImage(leafCanvas, 0, 0, W, H);
    }

    // 3. 방향 화살표 – showCourse 토글 적용
    if (showCourse) {
      const drawArrowAt = (x, y, angle) => {
        const SIZE = 5;
        ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
        ctx.beginPath(); ctx.moveTo(0, -SIZE); ctx.lineTo(SIZE * 0.85, SIZE * 0.9); ctx.lineTo(-SIZE * 0.85, SIZE * 0.9);
        ctx.closePath(); ctx.fillStyle = '#222'; ctx.fill(); ctx.restore();
      };

      for (let i = 0; i < waypoints.length - 1; i++) {
        const a = waypoints[i], b = waypoints[i + 1];
        const seg = badgeSegments[i];
        const useCurve = seg ? seg.curved : (isLoop ? 1 : 0);
        if (useCurve) {
          [0.25, 0.75].forEach((t) => {
            const arcPt = getArcPointAt(a.lat, a.lng, b.lat, b.lng, t, useCurve);
            const pt = map.latLngToContainerPoint([arcPt.lat, arcPt.lng]);
            drawArrowAt(pt.x, pt.y, (arcPt.bearing * Math.PI) / 180);
          });
        } else {
          const bearing = calcBearing(a, b);
          const angle = (bearing * Math.PI) / 180;
          const ptA = map.latLngToContainerPoint([a.lat, a.lng]);
          const ptB = map.latLngToContainerPoint([b.lat, b.lng]);
          [0.25, 0.75].forEach((t) => {
            drawArrowAt(ptA.x + t * (ptB.x - ptA.x), ptA.y + t * (ptB.y - ptA.y), angle);
          });
        }
      }

      // 3b. isLoop 닫힘 화살표 (돌아오는길)
      if (isLoop && waypoints.length >= 2) {
        const a = waypoints[waypoints.length - 1], b = waypoints[0];
        [0.25, 0.75].forEach((t) => {
          const arcPt = getArcPointAt(a.lat, a.lng, b.lat, b.lng, t, 1);
          const pt = map.latLngToContainerPoint([arcPt.lat, arcPt.lng]);
          drawArrowAt(pt.x, pt.y, (arcPt.bearing * Math.PI) / 180);
        });
      }
    } // end showCourse arrows

    // 동일 위치 waypoint 그룹핑 (화면 렌더링과 동일)
    const expGroups = [];
    const expAssigned = new Array(waypoints.length).fill(false);
    for (let i = 0; i < waypoints.length; i++) {
      if (expAssigned[i]) continue;
      const g = { wp: waypoints[i], indices: [i], lat: waypoints[i].lat, lng: waypoints[i].lng };
      for (let j = i + 1; j < waypoints.length; j++) {
        if (expAssigned[j]) continue;
        if (waypoints[j].name === waypoints[i].name && Math.hypot(waypoints[j].lat - waypoints[i].lat, waypoints[j].lng - waypoints[i].lng) < 0.002) {
          g.indices.push(j);
          expAssigned[j] = true;
          if (!g.wp.imgUrl && waypoints[j].imgUrl) g.wp = waypoints[j];
        }
      }
      expAssigned[i] = true;
      expGroups.push(g);
    }

    const expPts = expGroups.map(g => map.latLngToContainerPoint([g.lat, g.lng]));
    const expBadgePts = (showBadge && showCourse)
      ? badgeSegments.map(s => map.latLngToContainerPoint([s.midLat, s.midLng]))
      : [];
    const expOffsets = computeOffsets(expPts, expBadgePts);

    // pass 1: 리더라인 + 핀 도트 (배지보다 아래에 먼저 그림)
    expGroups.forEach((_g, gi) => {
      const pt = expPts[gi];
      const { dx: ox, dy: oy } = expOffsets[gi];
      if (ox === 0 && oy === 0) return;

      // 점선 리더라인
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#B8B8B8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(pt.x, pt.y);
      ctx.lineTo(pt.x + ox, pt.y + oy);
      ctx.stroke();
      ctx.restore();

      // 핀 도트
      ctx.save();
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    });

    // 4. 교통수단 배지 (showBadge + showCourse 둘 다 켜져야 표시)
    if (showBadge && showCourse) {
      const drawBadge = (pt, modeKey) => {
        if (modeKey && !visibleModes[modeKey]) return; // visibleModes 필터
        const R = 13;
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.18)';
        ctx.shadowBlur = 6;
        ctx.shadowOffsetY = 2;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, R, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.restore();

        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, R, 0, Math.PI * 2);
        ctx.stroke();

        const iconImg = ICON_IMGS[modeKey || 'bus'];
        const SZ = 16;
        if (iconImg && iconImg.complete) {
          ctx.drawImage(iconImg, pt.x - SZ / 2, pt.y - SZ / 2, SZ, SZ);
        }
      };

      for (let i = 0; i < waypoints.length - 1; i++) {
        const a = waypoints[i], b = waypoints[i + 1];
        const seg = badgeSegments[i];
        const useCurve = seg ? seg.curved : (isLoop ? 1 : 0);
        if (useCurve) {
          const arcMid = getArcPointAt(a.lat, a.lng, b.lat, b.lng, 0.5, useCurve);
          const pt = map.latLngToContainerPoint([arcMid.lat, arcMid.lng]);
          drawBadge(pt, transportModes[i] || 'bus');
        } else {
          const pt = map.latLngToContainerPoint([
            (a.lat + b.lat) / 2,
            (a.lng + b.lng) / 2,
          ]);
          drawBadge(pt, transportModes[i] || 'bus');
        }
      }

      // 4b. isLoop 닫힘 배지 (돌아오는길 곡선 중점)
      if (isLoop && waypoints.length >= 2) {
        const a = waypoints[waypoints.length - 1], b = waypoints[0];
        const arcMid = getArcPointAt(a.lat, a.lng, b.lat, b.lng, 0.5, 1);
        const pt = map.latLngToContainerPoint([arcMid.lat, arcMid.lng]);
        drawBadge(pt, loopTransportMode || 'bus');
      }
    } // end showBadge

    // 4. 번호 마커(or 사진 마커) + 지역명 라벨 (그룹핑 적용)
    expGroups.forEach((g, gi) => {
      const wp = g.wp;
      const pt = expPts[gi];
      const { dx: ox, dy: oy } = expOffsets[gi];
      const numLabel = g.indices.map(idx => idx + 1).join(' · ');

      // ── 공통 pill 드로잉 헬퍼 (markerScale 적용) ──────────────
      const drawPill = (pillCX, pillCY, numStr, nameStr) => {
        const PILL_H = 26 * markerScale;
        const NUM_R  = 10 * markerScale;
        // 번호 텍스트 폭 측정 → 원 or pill 형태 결정
        ctx.font = `800 ${Math.round(10 * markerScale)}px 'Noto Sans KR', sans-serif`;
        const numTextW = ctx.measureText(numStr).width;
        const numBadgeW = Math.max(NUM_R * 2, numTextW + 8 * markerScale); // 최소 원형, 필요시 확장
        const numBadgeH = NUM_R * 2;
        ctx.font = `600 ${Math.round(13 * markerScale)}px 'Noto Sans KR', sans-serif`;
        const nameW = ctx.measureText(nameStr).width;
        const pillW = showCourse ? (4 * markerScale + numBadgeW + 5 * markerScale + nameW + 10 * markerScale)
                                 : (10 * markerScale + nameW + 10 * markerScale);
        const px = pillCX - pillW / 2;
        const py = pillCY - PILL_H / 2;

        // pill 배경 (흰색)
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.22)';
        ctx.shadowBlur = 10 * markerScale;
        ctx.shadowOffsetY = 2;
        drawRoundRect(ctx, px, py, pillW, PILL_H, PILL_H / 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.restore();

        // pill 테두리 (연한 검정)
        ctx.strokeStyle = 'rgba(0,0,0,0.14)';
        ctx.lineWidth = 1.5;
        drawRoundRect(ctx, px, py, pillW, PILL_H, PILL_H / 2);
        ctx.stroke();

        if (showCourse) {
          // 번호 배지 (검정 배경, 흰 숫자) — 텍스트 폭에 따라 원형 or pill형
          const numCX = px + 4 * markerScale + numBadgeW / 2;
          const numCY = pillCY;
          const numBadgeR = numBadgeH / 2;
          drawRoundRect(ctx, numCX - numBadgeW / 2, numCY - numBadgeR, numBadgeW, numBadgeH, numBadgeR);
          ctx.fillStyle = '#1a1a1a';
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.font = `800 ${Math.round(10 * markerScale)}px 'Noto Sans KR', sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(numStr, numCX, numCY);

          // 지역명 (검정, 번호 오른쪽)
          ctx.fillStyle = '#111';
          ctx.font = `600 ${Math.round(13 * markerScale)}px 'Noto Sans KR', sans-serif`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(nameStr, numCX + numBadgeW / 2 + 5 * markerScale, numCY);
        } else {
          // 지역명만 (pill 중앙 정렬)
          ctx.fillStyle = '#111';
          ctx.font = `600 ${Math.round(13 * markerScale)}px 'Noto Sans KR', sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(nameStr, pillCX, pillCY);
        }
      };

      if (showPhoto) {
        // ── 사진 원형 + pill 일체형 ──────────────────────────
        const PR = 32 * markerScale; // photo radius (markerScale 적용)
        const cx = pt.x + ox, cy = pt.y + oy; // 겹침 방지 오프셋 적용

        // 흰 테두리 + 그림자
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.28)';
        ctx.shadowBlur = 14;
        ctx.shadowOffsetY = 3;
        ctx.beginPath();
        ctx.arc(cx, cy, PR, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.restore();

        // 사진 or 플레이스홀더
        const innerR = PR - 3 * markerScale;
        if (wp.imgUrl) {
          const imgObj = wpImgCache[wp.imgUrl];
          if (imgObj && imgObj.complete && imgObj.naturalWidth) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
            ctx.clip();
            ctx.drawImage(imgObj, cx - innerR, cy - innerR, innerR * 2, innerR * 2);
            ctx.restore();
          } else {
            ctx.beginPath();
            ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
            ctx.fillStyle = '#e0e0e0';
            ctx.fill();
          }
        } else {
          ctx.beginPath();
          ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
          ctx.fillStyle = '#e0e0e0';
          ctx.fill();
        }

        // 사진 아래 pill (gap 5px)
        const pillCY = cy + PR + 5 * markerScale + 13 * markerScale; // photo bottom + gap + pill half-height
        drawPill(cx, pillCY, numLabel, wp.name);

      } else {
        // ── 번호+이름 pill (겹침 방지 오프셋 적용) ────────────
        drawPill(pt.x + ox, pt.y + oy, numLabel, wp.name);
      }
    });

    // 다운로드
    const link    = document.createElement('a');
    link.download = `travel-route-${new Date().toISOString().slice(0, 10)}.png`;
    link.href     = out.toDataURL('image/png');
    link.click();
  } catch (err) {
    console.error('Export error:', err);
    alert('이미지 저장 중 오류가 발생했습니다.\n개발자 도구 콘솔을 확인해주세요.');
  } finally {
    exportOverlay.classList.remove('visible');
  }
});

// ─── Utilities ───────────────────────────────────────────────
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Init ────────────────────────────────────────────────────
render();
