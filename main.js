import mapboxgl from 'mapbox-gl';
import { twoline2satrec, propagate, gstime, eciToGeodetic, degreesLat, degreesLong } from 'satellite.js';
import { SATELLITES } from './satellites.js';

// Auto-detect all images in each country folder via Vite glob import
const _moroccoGlob  = import.meta.glob('/public/morocco/*',  { eager: true, as: 'url' });
const _austriaGlob  = import.meta.glob('/public/austria/*',  { eager: true, as: 'url' });
const _senegalGlob  = import.meta.glob('/public/senegal/*',  { eager: true, as: 'url' });
const sortUrls = (glob) =>
    Object.keys(glob).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(k => glob[k]);

const COUNTRY_PHOTOS = {
    MA: sortUrls(_moroccoGlob),
    AT: sortUrls(_austriaGlob),
    SN: sortUrls(_senegalGlob),
};

console.log('=== SATELLITE TRACKER ===');

// ============================================================================
// DEBUG
// ============================================================================
const DEBUG_LOG = [];
function debugLog(msg) {
    const fullMsg = `[${new Date().toLocaleTimeString()}] ${msg}`;
    console.log(fullMsg);
    DEBUG_LOG.push(fullMsg);
    const el = document.getElementById('debugContent');
    if (el) el.innerHTML = DEBUG_LOG.slice(-15).map(l =>
        `<div style="margin:2px 0;padding:2px 0;border-bottom:1px solid #222;">${l}</div>`
    ).join('');
}

// ============================================================================
// MAPBOX
// ============================================================================
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

// ============================================================================
// STATE
// ============================================================================
let map;

// Per-satellite: { satrec, color, enabled, trailCoords, srcId, glowId, lineId, lastTrailTime, currentLngLat }
const satState = [];

let selectedSatIdx = 0;
let currentStyle = 'light';
let isTracking = false;
let isSpinning = false;
let spinAnimId = null;
let labelMode = 'all'; // 'all' | 'countries' | 'none'
let trailType = 'solid';
let bgMode = 'stars'; // 'stars' | 'grid' | 'both' | 'off'
let uiVisible = true;
let spinSpeed = 0.02;
let smoothMode = true;
let themeMode = 'default'; // 'default' | 'military'

// Timing
let lastGeoJSONUpdate = 0;
let lastInfoUpdate = 0;

const SAT_COLORS = [
    '#FF6B35', '#F7C59F', '#3A86FF', '#FFBE0B', '#06D6A0',
    '#EF476F', '#118AB2', '#8338EC', '#FB5607', '#FFD166',
    '#1A936F', '#C6D8FF', '#E84855', '#06A77D', '#CF4A30',
    '#4B1D3F', '#A3333D', '#D62246', '#004E89', '#E9C46A'
];
const satColor = (idx) => SAT_COLORS[idx % SAT_COLORS.length];

// ============================================================================
// INIT
// ============================================================================
async function init() {
    try {
        debugLog('Initializing...');

        map = new mapboxgl.Map({
            container: 'map-container',
            style: 'mapbox://styles/mapbox/dark-v11',
            center: [0, 20], zoom: 2, pitch: 0, bearing: 0,
            antialias: true, projection: 'globe',
            dragPan: false, dragRotate: false, touchPitch: false,
        });

        setupMouseControls();

        map.on('load', () => {
            debugLog('Map loaded');
            setupMapLayers();
            initGraticuleLayer();
            initCountryLayers();
            initSatellites();
            setupEventListeners();
            animate();
        });

        map.on('error', (e) => debugLog(`Map error: ${e.error?.message}`));
    } catch (e) {
        debugLog(`ERROR: ${e.message}`);
    }
}

// ============================================================================
// MOUSE CONTROLS (with optional momentum toggled by C)
// ============================================================================

// Velocity accumulators for momentum mode
const vel = { panX: 0, panY: 0, bearing: 0, pitch: 0 };
const DAMPING = 0.9875;    // how quickly momentum fades — doubled coast time
const DAMPING_NORMAL = 0.88; // damping when smooth mode is off
const MIN_VEL = 0.003;     // zero-out below this threshold
const SMOOTH_SENS = 0.28;  // sensitivity scale in smooth mode (lower = heavier feel)
const MAX_TRAIL_POINTS = 480; // ~2 min of trail at 250ms; short enough to always be a clean single-direction arc

function tickMomentum() {
    if (!smoothMode) return;

    let active = false;

    if (Math.abs(vel.panX) > MIN_VEL || Math.abs(vel.panY) > MIN_VEL) {
        const center = map.getCenter();
        const cp = map.project([center.lng, center.lat]);
        const np = map.unproject({ x: cp.x - vel.panX, y: cp.y - vel.panY });
        map.setCenter([np.lng, np.lat]);
        vel.panX *= DAMPING;
        vel.panY *= DAMPING;
        active = true;
    } else {
        vel.panX = 0; vel.panY = 0;
    }

    if (Math.abs(vel.bearing) > MIN_VEL || Math.abs(vel.pitch) > MIN_VEL) {
        map.setBearing(map.getBearing() + vel.bearing);
        map.setPitch(Math.min(85, Math.max(0, map.getPitch() + vel.pitch)));
        vel.bearing *= DAMPING;
        vel.pitch *= DAMPING;
        active = true;
    } else {
        vel.bearing = 0; vel.pitch = 0;
    }

    if (active) requestAnimationFrame(tickMomentum);
    else momentumRunning = false;
}

let momentumRunning = false;
function kickMomentum() {
    if (!momentumRunning) {
        momentumRunning = true;
        requestAnimationFrame(tickMomentum);
    }
}

function setupMouseControls() {
    const canvas = map.getCanvas();
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    let activeButton = -1, lastX = 0, lastY = 0;
    // Track last few deltas for momentum seed on mouse-up
    let recentDx = 0, recentDy = 0;

    canvas.addEventListener('mousedown', (e) => {
        activeButton = e.button;
        lastX = e.clientX; lastY = e.clientY;
        recentDx = 0; recentDy = 0;
        e.preventDefault();
        // Kill any ongoing momentum on new drag
        vel.panX = 0; vel.panY = 0; vel.bearing = 0; vel.pitch = 0;
        if (e.button === 0) {
            // Pan cancels tracking and spin
            if (isTracking) { isTracking = false; updateFollowBtn(); }
            if (isSpinning) {
                isSpinning = false;
                if (spinAnimId) cancelAnimationFrame(spinAnimId);
                spinAnimId = null;
                const btn = document.getElementById('toggleSpinBtn');
                if (btn) btn.textContent = 'Spin: Off';
            }
        }
    }, false);

    document.addEventListener('mousemove', (e) => {
        if (activeButton === -1) return;
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        // Smooth input: slow lerp = heavy acceleration feel (Optifine-style)
        if (smoothMode) {
            recentDx = recentDx * 0.90 + dx * 0.10;
            recentDy = recentDy * 0.90 + dy * 0.10;
        } else {
            recentDx = dx; recentDy = dy;
        }
        lastX = e.clientX; lastY = e.clientY;

        // Scale applied delta: smooth mode uses reduced sensitivity
        const sens = smoothMode ? SMOOTH_SENS : 1.0;

        if (activeButton === 0) {
            const center = map.getCenter();
            const cp = map.project([center.lng, center.lat]);
            const np = map.unproject({ x: cp.x - recentDx * sens, y: cp.y - recentDy * sens });
            map.setCenter([np.lng, np.lat]);
        } else if (activeButton === 1) {
            map.setBearing(map.getBearing() + recentDx * 0.4 * sens);
            map.setPitch(Math.min(85, Math.max(0, map.getPitch() - recentDy * 0.4 * sens)));
        } else if (activeButton === 2) {
            map.setZoom(Math.min(22, Math.max(0, map.getZoom() - recentDy * 0.02)));
        }
    }, false);

    document.addEventListener('mouseup', (e) => {
        if (smoothMode && activeButton !== -1) {
            // Seed momentum from smoothed delta — already at reduced sensitivity
            if (activeButton === 0) {
                vel.panX = recentDx * SMOOTH_SENS;
                vel.panY = recentDy * SMOOTH_SENS;
            } else if (activeButton === 1) {
                vel.bearing = recentDx * 0.4 * SMOOTH_SENS;
                vel.pitch   = -recentDy * 0.4 * SMOOTH_SENS;
            }
            kickMomentum();
        }
        activeButton = -1;
    }, false);
}

// ============================================================================
// MAP SETUP
// ============================================================================
function applyFog() {
    const mil = themeMode === 'military';
    try {
        map.setFog({
            'color':         mil ? '#020702' : '#06060D',
            'high-color':    mil ? '#040D04' : '#0B0B17',
            'space-color':   mil ? '#010401' : '#06060D',
            'star-intensity': (bgMode === 'stars' || bgMode === 'both') ? 0.9 : 0,
            'horizon-blend': 0.02, 'range': [0.8, 8]
        });
    } catch (_) {}
}

function applyColorPalette() {
    // Terrain (outdoors) style uses its own realistic land/water colors — don't override them
    if (currentStyle === 'terrain') {
        applyUITheme();
        applyFog();
        return;
    }
    const mil = themeMode === 'military';
    const LAND       = mil ? '#040D04' : '#0B0B17';
    const OCEAN      = mil ? '#010801' : '#171730';
    const BORDER     = mil ? '#1A5C1A' : '#932C16';
    const BORDER_DIM = mil ? '#0F3A0F' : '#6C2416';
    const BG         = mil ? '#020702' : '#06060D';
    const p = (layer, prop, val) => {
        try { if (map.getLayer(layer)) map.setPaintProperty(layer, prop, val); } catch (_) {}
    };
    p('background', 'background-color', BG);
    ['land', 'landcover', 'land-structure-polygon'].forEach(l => p(l, 'background-color', LAND));
    ['water', 'water-shadow', 'waterway'].forEach(l => p(l, 'fill-color', OCEAN));
    p('waterway', 'line-color', OCEAN);
    p('water', 'fill-outline-color', BORDER);
    ['national-park', 'landuse', 'landuse-shadow', 'pitch-outline'].forEach(l => p(l, 'fill-color', LAND));
    ['admin-0-boundary', 'admin-0-boundary-disputed', 'admin-0-boundary-bg'].forEach(l => p(l, 'line-color', BORDER));
    ['admin-1-boundary', 'admin-1-boundary-bg'].forEach(l => p(l, 'line-color', BORDER_DIM));
    [
        'road-primary', 'road-secondary-tertiary', 'road-street', 'road-minor',
        'road-major-link', 'road-motorway-trunk',
        'tunnel-primary', 'tunnel-secondary-tertiary',
        'bridge-primary', 'bridge-secondary-tertiary',
    ].forEach(l => { try { if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', 'none'); } catch (_) {} });
    // Theme the UI chrome
    applyUITheme();
    applyFog();
}

function applyUITheme() {
    const mil = themeMode === 'military';
    const accent = mil ? '#1a6b1a' : '#932c16';
    const accentDim = mil ? '#0f3a0f' : '#6c2416';
    const panelBg = mil ? 'rgba(2,14,2,0.97)' : 'rgba(38,22,19,0.95)';
    const panelBgHeader = mil ? 'rgba(10,40,10,0.4)' : 'rgba(108,36,22,0.3)';
    const textAccent = mil ? '#4caf50' : '#b8860b';

    // Controls panel (bottom-right)
    const cp = document.getElementById('controls-panel');
    if (cp) {
        cp.style.background = panelBg;
        cp.style.borderColor = accent;
    }
    // Info panel (bottom-left)
    const ip = document.getElementById('issPanel');
    if (ip) {
        ip.style.borderColor = accent;
        ip.style.background = panelBg;
    }
    const ph = document.getElementById('panelHeader');
    if (ph) { ph.style.borderBottomColor = accent; ph.style.background = panelBgHeader; }

    document.querySelectorAll('.label').forEach(el => { el.style.color = textAccent; });
    document.querySelectorAll('.select-button').forEach(el => { el.style.background = accent; });

    // Sat list panel
    const slp = document.getElementById('satListPanel');
    if (slp) { slp.style.borderColor = accent; slp.style.background = mil ? 'rgba(2,10,2,0.97)' : 'rgba(6,6,13,0.97)'; }

    // Sat list panel header
    const slpHeader = document.querySelector('#satListPanel > div:first-child');
    if (slpHeader) { slpHeader.style.borderBottomColor = accent; slpHeader.style.background = panelBgHeader; }

    // Top-left fixed buttons: DEBUG, Satellites, Reset View
    const debugBtn = document.getElementById('debugToggle');
    if (debugBtn) { debugBtn.style.background = accent; debugBtn.style.borderColor = accent; debugBtn.style.color = '#fff'; }
    const satToggle = document.getElementById('satListToggle');
    if (satToggle) { satToggle.style.borderColor = accent; satToggle.style.color = mil ? '#7fff7f' : '#fff'; satToggle.style.background = 'transparent'; }
    const resetBtn = document.getElementById('resetButton');
    if (resetBtn) { resetBtn.style.borderColor = accent; resetBtn.style.color = mil ? '#7fff7f' : '#fff'; }

    // All buttons: reset background then set border
    ['styleLight','styleSatellite','styleTerrain','resetTrailBtn',
     'toggleLabelsBtn','toggleTrailBtn','toggleStarsBtn','toggleSpinBtn',
     'enableAllBtn','disableAllBtn'].forEach(id => {
        const b = document.getElementById(id);
        if (!b) return;
        b.style.background = 'transparent';
        b.style.borderColor = accent;
        b.style.color = mil ? '#7fff7f' : '#ffffff';
    });

    // Active style button fill
    updateStyleButtons();

    // Smooth + theme buttons
    updateSmoothBtn();
    updateThemeBtn();

    // BG and scrollbar
    applyBG();

    // scrollbar accent
    const style = document.getElementById('dynamic-theme-style') || (() => {
        const s = document.createElement('style'); s.id = 'dynamic-theme-style'; document.head.appendChild(s); return s;
    })();
    style.textContent = mil
        ? `::-webkit-scrollbar-thumb { background: #1a6b1a !important; }
           ::-webkit-scrollbar-thumb:hover { background: #2d9e2d !important; }`
        : `::-webkit-scrollbar-thumb { background: #932c16 !important; }
           ::-webkit-scrollbar-thumb:hover { background: #b8360f !important; }`;
}

function updateSmoothBtn() {
    const mil = themeMode === 'military';
    const accent = mil ? '#1a6b1a' : '#932c16';
    const indicator = document.getElementById('smoothIndicator');
    if (!indicator) return;
    indicator.textContent = smoothMode ? 'Smooth: On' : 'Smooth: Off';
    indicator.style.background = smoothMode ? accent : 'transparent';
    indicator.style.borderColor = smoothMode ? accent : (mil ? '#2a4a2a' : '#555');
    indicator.style.color = smoothMode ? '#fff' : (mil ? '#4a7a4a' : '#666');
}

function updateThemeBtn() {
    const mil = themeMode === 'military';
    const btn = document.getElementById('themeToggleBtn');
    if (!btn) return;
    btn.textContent = mil ? 'Theme: Military' : 'Theme: Default';
    btn.style.background = mil ? '#1a6b1a' : 'transparent';
    btn.style.borderColor = mil ? '#1a6b1a' : '#932c16';
    btn.style.color = mil ? '#fff' : '#ffffff';
}

function setupMapLayers() {
    try {
        if (!map.getSource('mapbox-dem')) {
            map.addSource('mapbox-dem', {
                type: 'raster-dem', url: 'mapbox://mapbox.mapbox-terrain-v2', tileSize: 512, maxZoom: 14
            });
            map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.5 });
        }
        applyColorPalette();
    } catch (e) { debugLog(`Layer setup error: ${e.message}`); }
}

// ============================================================================
// COUNTRY GALLERY
// ============================================================================
const COUNTRY_DATA = {
    MA: { name: 'Morocco', centroid: [-6.0, 31.8], iso: 'MA' },
    AT: { name: 'Austria', centroid: [14.5, 47.5],  iso: 'AT' },
    SN: { name: 'Senegal', centroid: [-14.5, 14.5], iso: 'SN' },
};

let activeCountryIso = null;   // currently highlighted country ISO
let galleryPhotoIdx = 0;       // current photo index (0-based)
let galleryRafId = null;       // rAF id for popup repositioning

function initCountryLayers() {
    // Add the Mapbox country-boundaries tileset as a vector source
    if (!map.getSource('country-boundaries')) {
        map.addSource('country-boundaries', {
            type: 'vector',
            url: 'mapbox://mapbox.country-boundaries-v1',
        });
    }

    // Invisible fill layer to capture clicks on all countries
    if (!map.getLayer('country-click-target')) {
        map.addLayer({
            id: 'country-click-target',
            type: 'fill',
            source: 'country-boundaries',
            'source-layer': 'country_boundaries',
            filter: ['in', 'iso_3166_1', 'MA', 'AT', 'SN'],
            paint: { 'fill-color': 'transparent', 'fill-opacity': 0 },
        });
    }

    // Highlight fill
    if (!map.getLayer('country-highlight')) {
        map.addLayer({
            id: 'country-highlight',
            type: 'fill',
            source: 'country-boundaries',
            'source-layer': 'country_boundaries',
            filter: ['==', 'iso_3166_1', ''],   // initially nothing
            paint: {
                'fill-color': themeMode === 'military' ? '#00cc00' : '#932c16',
                'fill-opacity': 0.25,
            },
        }, 'admin-0-boundary');
    }

    // Highlight border
    if (!map.getLayer('country-highlight-border')) {
        map.addLayer({
            id: 'country-highlight-border',
            type: 'line',
            source: 'country-boundaries',
            'source-layer': 'country_boundaries',
            filter: ['==', 'iso_3166_1', ''],
            paint: {
                'line-color': themeMode === 'military' ? '#00ff00' : '#ff4422',
                'line-width': 2,
                'line-opacity': 0.8,
            },
        }, 'admin-0-boundary');
    }

    // Connector line source (centroid → popup anchor)
    if (!map.getSource('country-connector')) {
        map.addSource('country-connector', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
        });
    }
    if (!map.getLayer('country-connector-line')) {
        map.addLayer({
            id: 'country-connector-line',
            type: 'line',
            source: 'country-connector',
            paint: {
                'line-color': '#ffffff',
                'line-width': 1.5,
                'line-opacity': 0.7,
                'line-dasharray': [4, 3],
            },
        });
    }

    // Click handler
    map.on('click', 'country-click-target', (e) => {
        const iso = e.features?.[0]?.properties?.iso_3166_1;
        if (!iso || !COUNTRY_DATA[iso]) return;
        if (activeCountryIso === iso) {
            closeCountryGallery();
        } else {
            openCountryGallery(iso);
        }
    });

    map.on('mouseenter', 'country-click-target', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'country-click-target', () => { map.getCanvas().style.cursor = ''; });
}

function openCountryGallery(iso) {
    closeCountryGallery(true); // close existing without clearing state
    activeCountryIso = iso;
    galleryPhotoIdx = 0;

    const c = COUNTRY_DATA[iso];
    const photos = COUNTRY_PHOTOS[iso] || [];
    const total = photos.length;
    const accent = themeMode === 'military' ? '#00cc00' : '#932c16';
    const accentBright = themeMode === 'military' ? '#00ff00' : '#ff4422';

    // Highlight
    map.setFilter('country-highlight', ['==', 'iso_3166_1', iso]);
    map.setFilter('country-highlight-border', ['==', 'iso_3166_1', iso]);
    map.setPaintProperty('country-highlight', 'fill-color', accent);
    map.setPaintProperty('country-highlight-border', 'line-color', accentBright);

    // Build popup DOM
    const popup = document.createElement('div');
    popup.id = 'country-gallery-popup';
    popup.style.cssText = `
        position: fixed; z-index: 200;
        background: rgba(8,8,16,0.96);
        border: 1px solid ${accent};
        border-radius: 6px;
        width: 300px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.7);
        pointer-events: auto;
        overflow: hidden;
        opacity: 0;
        transform: scale(0.85) translateY(8px);
        transition: opacity 0.25s ease, transform 0.25s ease;
    `;

    const firstSrc = total > 0 ? photos[0] : '';
    popup.innerHTML = `
        <div style="padding:10px 12px;background:rgba(${themeMode==='military'?'0,40,0':'60,20,10'},0.5);border-bottom:1px solid ${accent};display:flex;align-items:center;gap:8px;">
            <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${themeMode==='military'?'#7fff7f':'#fff'};flex:1;">${c.name}</span>
            <button id="gallery-close" style="background:transparent;border:none;color:#888;font-size:16px;cursor:pointer;padding:0 2px;line-height:1;">✕</button>
        </div>
        <div style="position:relative;width:100%;height:200px;overflow:hidden;cursor:pointer;">
            <img id="gallery-img" src="${firstSrc}"
                style="width:100%;height:100%;object-fit:cover;display:block;transition:opacity 0.2s ease;" />
            <!-- Left arrow -->
            <div id="gallery-prev" style="position:absolute;left:0;top:0;width:40%;height:100%;display:flex;align-items:center;justify-content:flex-start;padding-left:10px;cursor:pointer;z-index:2;">
                <span style="color:${accent};font-size:22px;text-shadow:0 0 8px rgba(0,0,0,0.9);opacity:0.85;user-select:none;">&#8249;</span>
            </div>
            <!-- Right arrow -->
            <div id="gallery-next" style="position:absolute;right:0;top:0;width:40%;height:100%;display:flex;align-items:center;justify-content:flex-end;padding-right:10px;cursor:pointer;z-index:2;">
                <span style="color:${accent};font-size:22px;text-shadow:0 0 8px rgba(0,0,0,0.9);opacity:0.85;user-select:none;">&#8250;</span>
            </div>
        </div>
        <div style="padding:8px 12px;display:flex;align-items:center;justify-content:space-between;">
            <span id="gallery-counter" style="font-size:10px;color:#888;font-family:monospace;">${total > 0 ? 1 : 0} / ${total}</span>
            <span style="font-size:10px;color:#555;">${total > 1 ? 'Click sides to browse' : ''}</span>
        </div>
    `;

    document.getElementById('ui-overlay').appendChild(popup);

    // Animate in
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            popup.style.opacity = '1';
            popup.style.transform = 'scale(1) translateY(0)';
        });
    });

    // Arrow + close handlers
    document.getElementById('gallery-close').addEventListener('click', (e) => {
        e.stopPropagation();
        closeCountryGallery();
    });
    document.getElementById('gallery-prev').addEventListener('click', (e) => {
        e.stopPropagation();
        galleryStep(-1);
    });
    document.getElementById('gallery-next').addEventListener('click', (e) => {
        e.stopPropagation();
        galleryStep(1);
    });

    // Start repositioning loop
    positionGalleryPopup();
    galleryRafId = requestAnimationFrame(galleryPositionLoop);
}

function galleryStep(dir) {
    if (!activeCountryIso) return;
    const photos = COUNTRY_PHOTOS[activeCountryIso] || [];
    if (photos.length < 2) return;
    galleryPhotoIdx = (galleryPhotoIdx + dir + photos.length) % photos.length;
    const img = document.getElementById('gallery-img');
    const counter = document.getElementById('gallery-counter');
    if (img) {
        img.style.opacity = '0';
        setTimeout(() => {
            img.src = photos[galleryPhotoIdx];
            img.style.opacity = '1';
        }, 150);
    }
    if (counter) counter.textContent = `${galleryPhotoIdx + 1} / ${photos.length}`;
}

function galleryPositionLoop() {
    positionGalleryPopup();
    galleryRafId = requestAnimationFrame(galleryPositionLoop);
}

function positionGalleryPopup() {
    if (!activeCountryIso) return;
    const popup = document.getElementById('country-gallery-popup');
    if (!popup) return;
    const c = COUNTRY_DATA[activeCountryIso];

    // Project centroid to screen
    const pt = map.project(c.centroid);

    // Offset: place popup to the right (or left if near right edge)
    const W = window.innerWidth, H = window.innerHeight;
    const popW = 300, popH = 270;
    const offsetX = 40, offsetY = -popH / 2;

    let px = pt.x + offsetX;
    let py = pt.y + offsetY;

    // Clamp to viewport
    if (px + popW > W - 20) px = pt.x - popW - offsetX;
    if (py < 10) py = 10;
    if (py + popH > H - 10) py = H - popH - 10;
    // Anchor point for leader line (the side of the popup facing the centroid)
    const anchorX = px < pt.x ? px + popW : px;
    const anchorY = py + popH / 2;

    popup.style.left = px + 'px';
    popup.style.top  = py + 'px';

    // Update connector line
    try {
        map.getSource('country-connector')?.setData({
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: [
                        c.centroid,
                        map.unproject([anchorX, anchorY]),
                    ],
                },
            }],
        });
    } catch (_) {}
}

function closeCountryGallery(silent = false) {
    if (galleryRafId) { cancelAnimationFrame(galleryRafId); galleryRafId = null; }

    const popup = document.getElementById('country-gallery-popup');
    if (popup) {
        popup.style.opacity = '0';
        popup.style.transform = 'scale(0.85) translateY(8px)';
        setTimeout(() => popup.remove(), 250);
    }

    // Clear highlight + connector
    try { map.setFilter('country-highlight', ['==', 'iso_3166_1', '']); } catch (_) {}
    try { map.setFilter('country-highlight-border', ['==', 'iso_3166_1', '']); } catch (_) {}
    try { map.getSource('country-connector')?.setData({ type: 'FeatureCollection', features: [] }); } catch (_) {}

    if (!silent) activeCountryIso = null;
}

// ============================================================================
// GRATICULE (geographic grid — moves with the globe)
// ============================================================================
function buildGraticuleGeoJSON(step) {
    const features = [];
    // Longitude lines
    for (let lng = -180; lng <= 180; lng += step) {
        const coords = [];
        for (let lat = -90; lat <= 90; lat += 2) coords.push([lng, lat]);
        features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } });
    }
    // Latitude lines
    for (let lat = -90; lat <= 90; lat += step) {
        const coords = [];
        for (let lng = -180; lng <= 180; lng += 2) coords.push([lng, lat]);
        features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } });
    }
    return { type: 'FeatureCollection', features };
}

function initGraticuleLayer() {
    if (!map.getSource('graticule')) {
        map.addSource('graticule', { type: 'geojson', data: buildGraticuleGeoJSON(30) });
    }
    if (!map.getLayer('graticule-lines')) {
        map.addLayer({
            id: 'graticule-lines',
            type: 'line',
            source: 'graticule',
            paint: {
                'line-color': themeMode === 'military' ? '#00aa00' : '#ffffff',
                'line-opacity': themeMode === 'military' ? 0.10 : 0.06,
                'line-width': 0.5,
            }
        }, 'admin-0-boundary'); // insert below country borders
    }
    applyGraticuleVisibility();
}

function applyGraticuleVisibility() {
    const show = bgMode === 'grid' || bgMode === 'both';
    const mil = themeMode === 'military';
    try {
        map.setLayoutProperty('graticule-lines', 'visibility', show ? 'visible' : 'none');
        if (show) {
            map.setPaintProperty('graticule-lines', 'line-color', mil ? '#00cc00' : '#ffffff');
            map.setPaintProperty('graticule-lines', 'line-opacity', mil ? 0.12 : 0.07);
        }
    } catch (_) {}
}
function buildTrailGeoJSON(coords) {
    if (coords.length < 2) return { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } };
    // Normalize longitudes so they're continuous (no ±180 wrap jump).
    // Globe projection renders geodesic arcs correctly; no manual antimeridian split needed.
    const norm = [coords[0].slice()];
    for (let i = 1; i < coords.length; i++) {
        let lng = coords[i][0];
        const prev = norm[i - 1][0];
        // Unwrap: bring lng within ±180° of previous
        while (lng - prev > 180) lng -= 360;
        while (prev - lng > 180) lng += 360;
        norm.push([lng, coords[i][1]]);
    }
    return { type: 'Feature', geometry: { type: 'LineString', coordinates: norm } };
}

// ============================================================================
// SATELLITE POSITION GEOJSON LAYER (replaces HTML markers for reliability)
// ============================================================================
function buildSatPointsGeoJSON() {
    const features = [];
    satState.forEach((state, idx) => {
        if (!state.enabled || !state.currentLngLat) return;
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: state.currentLngLat },
            properties: {
                idx,
                color: state.color,
                selected: idx === selectedSatIdx ? 1 : 0,
            }
        });
    });
    return { type: 'FeatureCollection', features };
}

function initPositionLayers() {
    if (!map.getSource('sat-positions')) {
        map.addSource('sat-positions', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
    }

    // Glow ring (thick, semi-transparent, satellite color)
    if (!map.getLayer('sat-glow')) {
        map.addLayer({
            id: 'sat-glow',
            type: 'circle',
            source: 'sat-positions',
            paint: {
                'circle-radius': ['case', ['==', ['get', 'selected'], 1], 14, 9],
                'circle-color': ['get', 'color'],
                'circle-opacity': 0.28,
                'circle-blur': 1.0,
                'circle-pitch-alignment': 'map',
                'circle-pitch-scale': 'map',
            }
        });
    }

    // Crisp dot on top
    if (!map.getLayer('sat-dots')) {
        map.addLayer({
            id: 'sat-dots',
            type: 'circle',
            source: 'sat-positions',
            paint: {
                'circle-radius': ['case', ['==', ['get', 'selected'], 1], 6, 4],
                'circle-color': ['get', 'color'],
                'circle-stroke-width': 1.5,
                'circle-stroke-color': ['case', ['==', ['get', 'selected'], 1], '#FFD166', '#ffffff'],
                'circle-pitch-alignment': 'map',
                'circle-pitch-scale': 'map',
            }
        });
    }
}

// ============================================================================
// TRAIL LAYERS (per satellite)
// ============================================================================
function addTrailLayers(state) {
    if (!map.getSource(state.srcId)) {
        map.addSource(state.srcId, { type: 'geojson', data: buildTrailGeoJSON(state.trailCoords) });
    }
    if (!map.getLayer(state.glowId)) {
        map.addLayer({
            id: state.glowId, type: 'line', source: state.srcId,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': state.color, 'line-width': 8, 'line-opacity': 0.22, 'line-blur': 3 }
        });
    }
    if (!map.getLayer(state.lineId)) {
        map.addLayer({
            id: state.lineId, type: 'line', source: state.srcId,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#FFFFFF', 'line-width': 1.2, 'line-opacity': 0.85, 'line-dasharray': [1, 0] }
        });
    }
}

// ============================================================================
// SATELLITE INITIALIZATION
// ============================================================================
function initSatellites() {
    const now = new Date();
    SATELLITES.forEach((sat, idx) => {
        const satrec = twoline2satrec(sat.tle1, sat.tle2);
        const color = satColor(idx);
        const srcId = `trail-${idx}`;
        const glowId = `trail-glow-${idx}`;
        const lineId = `trail-line-${idx}`;

        // Pre-populate 30-min trail
        const trailCoords = [];
        for (let i = 1800; i >= 0; i -= 10) {
            const t = new Date(now.getTime() - i * 1000);
            const pv = propagate(satrec, t);
            if (!pv || !pv.position) continue;
            const pos = eciToGeodetic(pv.position, gstime(t));
            trailCoords.push([degreesLong(pos.longitude), degreesLat(pos.latitude)]);
        }

        // Only ISS (idx 0) is enabled by default
        const enabled = idx === 0;

        const state = {
            satrec, color, trailCoords, srcId, glowId, lineId,
            lastTrailTime: Date.now(),
            enabled,
            currentLngLat: [0, 0],
        };

        addTrailLayers(state);
        if (!enabled) {
            try { map.setLayoutProperty(glowId, 'visibility', 'none'); } catch (_) {}
            try { map.setLayoutProperty(lineId, 'visibility', 'none'); } catch (_) {}
        }
        satState.push(state);
    });

    initPositionLayers();

    // Click on sat-dots layer — select AND start tracking that satellite
    map.on('click', 'sat-dots', (e) => {
        if (!e.features || !e.features.length) return;
        const idx = parseInt(e.features[0].properties.idx);
        selectSatellite(idx);
        isTracking = true;
        updateFollowBtn();
    });
    map.on('mouseenter', 'sat-dots', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'sat-dots', () => { map.getCanvas().style.cursor = ''; });

    selectSatellite(0);
    buildSatList();
    debugLog(`${SATELLITES.length} satellites initialized`);
}

// ============================================================================
// ANIMATION LOOP
// ============================================================================
function animate() {
    if (!map) return;
    const nowMs = Date.now();
    const now = new Date(nowMs);

    // Compute current positions — skip disabled satellites entirely
    SATELLITES.forEach((sat, idx) => {
        const state = satState[idx];
        if (!state || !state.enabled) return;

        const pv = propagate(state.satrec, now);
        if (!pv || !pv.position) return;

        const pos = eciToGeodetic(pv.position, gstime(now));
        const lat = degreesLat(pos.latitude);
        const lng = degreesLong(pos.longitude);
        state.currentLngLat = [lng, lat];

        // Track selected satellite
        if (idx === selectedSatIdx) {
            if (isTracking) map.setCenter([lng, lat]);
            // Update info panel at ~2fps
            if (nowMs - lastInfoUpdate > 500) {
                const speed = Math.sqrt(pv.velocity.x ** 2 + pv.velocity.y ** 2 + pv.velocity.z ** 2);
                updateInfoPanel(sat.name, lat, lng, pos.height, speed * 3600);
            }
        }
    });

    if (nowMs - lastInfoUpdate > 500) lastInfoUpdate = nowMs;

    // Update trail + GeoJSON at ~4fps (same rate as dot)
    if (nowMs - lastGeoJSONUpdate > 250) {
        lastGeoJSONUpdate = nowMs;

        satState.forEach((state, idx) => {
            if (!state.enabled || !state.currentLngLat) return;
            const [lng, lat] = state.currentLngLat;
            const last = state.trailCoords[state.trailCoords.length - 1];
            // Skip if position hasn't changed meaningfully (e.g. geostationary)
            if (!last || Math.abs(lng - last[0]) > 0.0001 || Math.abs(lat - last[1]) > 0.0001) {
                state.trailCoords.push([lng, lat]);
                if (state.trailCoords.length > MAX_TRAIL_POINTS) {
                    state.trailCoords.splice(0, state.trailCoords.length - MAX_TRAIL_POINTS);
                }
            }
            state.lastTrailTime = nowMs;
            try {
                map.getSource(state.srcId)?.setData(buildTrailGeoJSON(state.trailCoords));
            } catch (_) {}
        });

        try {
            map.getSource('sat-positions')?.setData(buildSatPointsGeoJSON());
        } catch (_) {}
    }

    requestAnimationFrame(animate);
}

// ============================================================================
// INFO PANEL
// ============================================================================
function updateInfoPanel(name, lat, lng, alt, vel) {
    const s = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    s('satName', name);
    s('satLat', lat.toFixed(4));
    s('satLng', lng.toFixed(4));
    s('satAlt', alt.toFixed(0) + ' km');
    s('satVel', vel.toFixed(0) + ' km/h');
}

// ============================================================================
// SELECTION
// ============================================================================
function selectSatellite(idx) {
    selectedSatIdx = idx;

    const header = document.getElementById('panelHeader');
    if (header) header.textContent = `${SATELLITES[idx].name} — ${SATELLITES[idx].type}`;

    document.querySelectorAll('.sat-list-item').forEach(li => {
        li.classList.toggle('active', parseInt(li.dataset.idx) === idx);
    });

    if (isTracking && satState[idx]?.currentLngLat) {
        map.setCenter(satState[idx].currentLngLat);
    }

    updateFollowBtn();

    // Force immediate GeoJSON update so selection highlight appears instantly
    try {
        map.getSource('sat-positions')?.setData(buildSatPointsGeoJSON());
    } catch (_) {}
}

function updateFollowBtn() {
    const btn = document.getElementById('selectSatButton');
    if (btn) btn.textContent = isTracking
        ? `Unfollow ${SATELLITES[selectedSatIdx]?.name ?? ''}`
        : `Follow ${SATELLITES[selectedSatIdx]?.name ?? ''}`;
}

// ============================================================================
// SATELLITE LIST
// ============================================================================
function buildSatList() {
    const container = document.getElementById('satListBody');
    if (!container) return;
    container.innerHTML = '';

    SATELLITES.forEach((sat, idx) => {
        const item = document.createElement('div');
        item.className = 'sat-list-item';
        item.dataset.idx = idx;

        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = idx === 0; cb.className = 'sat-checkbox';
        cb.addEventListener('change', (e) => { e.stopPropagation(); setSatEnabled(idx, cb.checked); });

        const dot = document.createElement('span');
        dot.className = 'sat-dot'; dot.style.background = satColor(idx);

        const nameSpan = document.createElement('span');
        nameSpan.className = 'sat-item-name'; nameSpan.textContent = sat.name;

        const typeSpan = document.createElement('span');
        typeSpan.className = 'sat-item-type'; typeSpan.textContent = sat.type;

        item.append(cb, dot, nameSpan, typeSpan);
        item.addEventListener('click', (e) => { if (e.target === cb) return; selectSatellite(idx); });
        container.appendChild(item);
    });
}

function setSatEnabled(idx, enabled) {
    const state = satState[idx];
    if (!state) return;
    state.enabled = enabled;
    const vis = enabled ? 'visible' : 'none';
    try { map.setLayoutProperty(state.glowId, 'visibility', vis); } catch (_) {}
    try { map.setLayoutProperty(state.lineId, 'visibility', vis); } catch (_) {}
    // Position dot is excluded via buildSatPointsGeoJSON filter
}

function setAllEnabled(enabled) {
    SATELLITES.forEach((_, idx) => {
        setSatEnabled(idx, enabled);
        const cb = document.querySelector(`.sat-list-item[data-idx="${idx}"] .sat-checkbox`);
        if (cb) cb.checked = enabled;
    });
}

// ============================================================================
// TOGGLES
// ============================================================================
// Country-name layer id substrings in Mapbox styles
const COUNTRY_LABEL_KEYS = ['country', 'state', 'continent'];
function isCountryLabel(id) { return COUNTRY_LABEL_KEYS.some(k => id.includes(k)); }

function toggleLabels() {
    const modes = ['all', 'countries', 'none'];
    labelMode = modes[(modes.indexOf(labelMode) + 1) % modes.length];
    map.getStyle().layers.forEach(l => {
        if (l.type !== 'symbol') return;
        let vis = 'visible';
        if (labelMode === 'none') vis = 'none';
        else if (labelMode === 'countries') vis = isCountryLabel(l.id) ? 'visible' : 'none';
        try { map.setLayoutProperty(l.id, 'visibility', vis); } catch (_) {}
    });
    const labels = { all: 'Labels: All', countries: 'Labels: Countries', none: 'Labels: None' };
    const btn = document.getElementById('toggleLabelsBtn');
    if (btn) btn.textContent = labels[labelMode];
}

function toggleTrailType() {
    const types = ['solid', 'dashed', 'dots'];
    trailType = types[(types.indexOf(trailType) + 1) % types.length];
    satState.forEach(state => {
        try {
            if (!map.getLayer(state.lineId)) return;
            if (trailType === 'dashed') {
                map.setPaintProperty(state.lineId, 'line-dasharray', [4, 3]);
                map.setPaintProperty(state.lineId, 'line-width', 1.2);
            } else if (trailType === 'solid') {
                map.setPaintProperty(state.lineId, 'line-dasharray', [1, 0]);
                map.setPaintProperty(state.lineId, 'line-width', 1.2);
            } else {
                map.setPaintProperty(state.lineId, 'line-dasharray', [0.5, 4]);
                map.setPaintProperty(state.lineId, 'line-width', 2);
            }
        } catch (_) {}
    });
    const btn = document.getElementById('toggleTrailBtn');
    if (btn) btn.textContent = `Trail: ${trailType.charAt(0).toUpperCase() + trailType.slice(1)}`;
}

function toggleStars() {
    const modes = ['stars', 'grid', 'both', 'off'];
    bgMode = modes[(modes.indexOf(bgMode) + 1) % modes.length];
    applyBG();
    const labels = { stars: 'BG: Stars', grid: 'BG: Grid', both: 'BG: Both', off: 'BG: Off' };
    const btn = document.getElementById('toggleStarsBtn');
    if (btn) btn.textContent = labels[bgMode];
}

function applyBG() {
    // Grid is now a Mapbox layer — just toggle its visibility and update star intensity
    document.body.style.background = themeMode === 'military' ? '#000800' : '#010102';
    applyGraticuleVisibility();
    applyFog();
}

function toggleSpin() {
    isSpinning = !isSpinning;
    const btn = document.getElementById('toggleSpinBtn');
    if (btn) btn.textContent = isSpinning ? 'Spin: On' : 'Spin: Off';
    if (isSpinning) {
        const step = () => {
            if (!isSpinning) return;
            const c = map.getCenter();
            map.setCenter([(c.lng - spinSpeed + 540) % 360 - 180, c.lat]);
            spinAnimId = requestAnimationFrame(step);
        };
        spinAnimId = requestAnimationFrame(step);
    } else {
        if (spinAnimId) { cancelAnimationFrame(spinAnimId); spinAnimId = null; }
    }
}

function selectCurrentSat() {
    isTracking = !isTracking;
    if (isTracking && satState[selectedSatIdx]?.currentLngLat) {
        map.setCenter(satState[selectedSatIdx].currentLngLat);
    }
    updateFollowBtn();
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================
function setupEventListeners() {
    const debugToggle = document.getElementById('debugToggle');
    const debugPanel = document.getElementById('debugPanel');
    if (debugToggle && debugPanel) {
        debugToggle.addEventListener('click', () => {
            debugPanel.style.display = debugPanel.style.display === 'none' ? 'block' : 'none';
        });
    }

    document.getElementById('resetButton')?.addEventListener('click', () => {
        map.flyTo({ center: [0, 20], zoom: 2, pitch: 0, bearing: 0, duration: 1200 });
    });

    document.getElementById('selectSatButton')?.addEventListener('click', selectCurrentSat);

    document.getElementById('satListToggle')?.addEventListener('click', () => {
        const panel = document.getElementById('satListPanel');
        if (!panel) return;
        panel.style.display = (panel.style.display === 'none' || !panel.style.display) ? 'flex' : 'none';
    });

    document.getElementById('enableAllBtn')?.addEventListener('click', () => setAllEnabled(true));
    document.getElementById('disableAllBtn')?.addEventListener('click', () => setAllEnabled(false));

    const styleMap = {
        styleLight:     { style: 'mapbox://styles/mapbox/dark-v11',    name: 'light' },
        styleSatellite: { style: 'mapbox://styles/mapbox/satellite-v9', name: 'satellite' },
        styleTerrain:   { style: 'mapbox://styles/mapbox/outdoors-v12', name: 'terrain' },
    };
    Object.entries(styleMap).forEach(([id, { style, name }]) => {
        document.getElementById(id)?.addEventListener('click', () => {
            currentStyle = name;
            map.setStyle(style);
            map.once('styledata', () => {
                setupMapLayers();
                initGraticuleLayer();
                initCountryLayers();
                satState.forEach(state => {
                    addTrailLayers(state);
                    // Re-apply visibility from enabled state
                    if (!state.enabled) {
                        try { map.setLayoutProperty(state.glowId, 'visibility', 'none'); } catch (_) {}
                        try { map.setLayoutProperty(state.lineId, 'visibility', 'none'); } catch (_) {}
                    }
                });
                initPositionLayers();
            });
            updateStyleButtons();
        });
    });

    document.getElementById('resetTrailBtn')?.addEventListener('click', () => {
        satState.forEach(state => {
            state.trailCoords = [];
            state.lastTrailTime = Date.now();
            try { map.getSource(state.srcId)?.setData(buildTrailGeoJSON([])); } catch (_) {}
        });
        debugLog('All trails reset');
    });

    document.getElementById('toggleLabelsBtn')?.addEventListener('click', toggleLabels);
    document.getElementById('toggleTrailBtn')?.addEventListener('click', toggleTrailType);
    document.getElementById('toggleStarsBtn')?.addEventListener('click', toggleStars);
    document.getElementById('toggleSpinBtn')?.addEventListener('click', toggleSpin);

    const slider = document.getElementById('spinSpeedSlider');
    if (slider) slider.addEventListener('input', () => { spinSpeed = parseFloat(slider.value) / 1000; });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'u' || e.key === 'U') {
            uiVisible = !uiVisible;
            const ui = document.getElementById('ui-overlay');
            if (ui) ui.style.display = uiVisible ? '' : 'none';
        }
        if (e.key === 'c' || e.key === 'C') { toggleSmooth(); }
    });

    document.getElementById('smoothIndicator')?.addEventListener('click', toggleSmooth);
    document.getElementById('themeToggleBtn')?.addEventListener('click', () => {
        themeMode = themeMode === 'default' ? 'military' : 'default';
        applyColorPalette();
        applyBG();
        // Update country highlight colors to match new theme
        const accent = themeMode === 'military' ? '#00cc00' : '#932c16';
        const accentBright = themeMode === 'military' ? '#00ff00' : '#ff4422';
        try { map.setPaintProperty('country-highlight', 'fill-color', accent); } catch (_) {}
        try { map.setPaintProperty('country-highlight-border', 'line-color', accentBright); } catch (_) {}
    });

    updateStyleButtons();
    updateSmoothBtn();
    updateThemeBtn();
    updateFollowBtn();
    debugLog('Event listeners ready');
}

function toggleSmooth() {
    smoothMode = !smoothMode;
    if (!smoothMode) { vel.panX = 0; vel.panY = 0; vel.bearing = 0; vel.pitch = 0; }
    updateSmoothBtn();
    debugLog(`Smooth camera ${smoothMode ? 'on' : 'off'}`);
}

function updateStyleButtons() {
    const mil = themeMode === 'military';
    const accent = mil ? '#1a6b1a' : '#932c16';
    [['styleLight', 'light'], ['styleSatellite', 'satellite'], ['styleTerrain', 'terrain']].forEach(([id, name]) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.style.background = currentStyle === name ? accent : 'transparent';
        btn.style.borderColor = accent;
        btn.style.border = currentStyle === name ? 'none' : `1px solid ${accent}`;
        btn.style.color = currentStyle === name ? '#fff' : (mil ? '#7fff7f' : '#ffffff');
    });
}

// ============================================================================
// START
// ============================================================================
debugLog('Script loaded');
document.addEventListener('DOMContentLoaded', () => { debugLog('DOM ready'); init(); });
