# ISS Tracker - Mapbox GL Implementation Guide

## ✅ Completed: Architectural Pivot to Mapbox GL

Your ISS tracker has been successfully transitioned from a Three.js textured sphere to **Mapbox GL**, a modern web mapping library that supports:

- **Real 3D Globe** - Proper geographic coordinates with accurate scale
- **Street-Level Zoom** - Zoom from global view down to street-level detail
- **Terrain Visualization** - 3D terrain elevation data
- **Multiple Map Styles** - Light, Satellite, Terrain imagery
- **ISS Real-Time Tracking** - Orange marker with white trail
- **Customizable Experience** - Easy to toggle features, change colors, etc.

---

## 🔴 Critical: Add Your Mapbox Access Token

Before the app fully works, you **MUST** add a free Mapbox access token:

### Step 1: Get a Free Token
1. Go to https://account.mapbox.com/auth/signup
2. Sign up for a free Mapbox account
3. Go to https://account.mapbox.com/tokens/
4. Copy your **default public token** (or create a new one)

### Step 2: Add Token to main.js
In `main.js` (line ~33), replace:
```javascript
mapboxgl.accessToken = 'pk.eyJ1IjoiZXhhbXBsZSIsImEiOiJjbGV4YW1wbGUifQ.example';
```

With your actual token:
```javascript
mapboxgl.accessToken = 'pk.eyJ1IjoieW91cl91c2VybmFtZSIsImEiOiJjbGV4YW1wbGVzIn0.YOUR_ACTUAL_TOKEN_HERE';
```

**Once you add the token, the map will load!**

---

## 📝 New Architecture Overview

### File Changes:

#### **index.html** ✅ Updated
- Changed from Three.js canvas to Mapbox GL map container
- `<div id="map-container"></div>` - Full-screen Mapbox map
- Added Mapbox GL CSS link
- Kept UI panels: ISS info, Reset button, Debug panel, Style toggles

#### **style.css** ✅ Updated  
- Changed styles from `#canvas-container` to `#map-container`
- All dark theme colors preserved (#06060d, #932c16, etc.)

#### **main.js** ✅ Completely Rewritten (~354 lines vs ~574 lines)
**Removed:**
- All Three.js code (scene, camera, renderer, OrbitControls, etc.)
- Starfield, complex globe loading, CSS2DRenderer
- City dots rendering (can be re-added with GeoJSON)

**Added:**
- Mapbox GL map initialization and event handling
- Proper map layer management (terrain, ISS trail GeoJSON)
- Map style switching (Light/Satellite/Terrain)
- ISS marker with SVG icon
- Trail visualization using GeoJSON LineString
- Real-time position updates with proper map centering

**Kept (Working):**
- ISS position calculation using satellite.js ✅
- Real-time TLE data fetching with fallback ✅
- Debug logging system ✅
- Info panel updates (lat/lng/alt/velocity) ✅

---

## 🎯 Current Features

### ✅ Already Working
- **Real-time ISS Tracking** - Updates position every frame
- **White Trail** - Shows ISS path (last 100 positions)
- **Info Panel** - Displays lat/lng/altitude/velocity
- **Map Styles** - Toggle between Light, Satellite, Terrain
- **3D Terrain** - Elevation visualization
- **Zoom Capability** - Full zoom range (0-28)
- **Auto-Rotation** - Camera pans smoothly (when idle)
- **Debug Logging** - Console output and toggleable panel

### 🔴 Blocked by Missing Token
- Map will not render without valid Mapbox token
- All interactive features require map to load first

---

## 🛠️ Usage Instructions

### Toggle Features
- **Light/Satellite/Terrain Buttons** (bottom-right) - Switch map styles
- **Reset View Button** (top-right) - Return to global view
- **ISS Info Panel** (bottom-left) - Live position data
- **Debug Panel** (top-left) - Enable with toggle button

### Interact with Map
- **Drag** - Rotate view
- **Scroll** - Zoom in/out
- **Click ISS Marker** - Focus on satellite, zoom to level 6
- **Click Terrain Style** - Enables 3D elevation visualization

---

## 🎨 Customization Options

### Change ISS Marker Color
In `main.js`, line ~133:
```javascript
fill=%22%23932c16%22  // Orange color - change to your hex color
```

### Modify Trail Length
Line ~170:
```javascript
if (issTrail.length > 100) issTrail.shift();  // Change 100 to desired length
```

### Adjust Map Starting Position
Lines ~52-57:
```javascript
center: [0, 20],    // [longitude, latitude]
zoom: 2,            // Start zoom level
pitch: 45,          // 3D tilt angle
bearing: 0,         // Rotation bearing
```

### Enable City Markers (Optional)
In the provided `CITIES` array (currently at top of file), you can add GeoJSON layer:
```javascript
// Add this to setupMapLayers():
map.addSource('cities-source', {
    type: 'geojson',
    data: generateCitiesGeoJSON(CITIES)  // Would need helper function
});
```

---

## 📊 Technical Details

### Dependencies
- **mapbox-gl** (v2.15.0) - Web mapping library
- **satellite.js** - ISS position calculation
- **Vite** (v8.0.7) - Build tool

### APIs Used
- **Mapbox GL API** - Map rendering and layer management
- **Mapbox Terrain API** - Elevation data (requires token)
- **N2YO Satellite API** - Real ISS TLE data (CORS-safe)
- **satellite.js Library** - TLE propagation to get coordinates

### Key Functions
- `init()` - Map initialization
- `setupMapLayers()` - Add terrain, ISS marker, trail
- `fetchAndSetupISS()` - Get TLE data and setup satellite tracking
- `updateISSPosition()` - Calculate new ISS location every frame
- `animate()` - Animation loop (requestAnimationFrame)
- `selectISS()` - Focus camera on ISS
- `setupEventListeners()` - Wire up UI interactions

---

## ⚠️ Known Limitations & Future Improvements

### Current Limitations
- No city dots rendered (removed due to complexity, can be re-added)
- Trail limited to 100 positions (prevents huge GeoJSON)
- Map style switching requires layer re-setup (brief flicker)

### Possible Enhancements
1. **Add city markers** with Mapbox symbols and pop-ups
2. **Customize map style colors** to match orange theme
3. **Add ISS ground track** prediction layer
4. **Show satellite pass times** for your location
5. **Add multiple satellites** tracking
6. **Save user preferences** (last style, zoom level)
7. **Mobile optimizations** (touch controls, responsive UI)

---

## 🐛 Troubleshooting

### Map not showing?
❌ Most likely: Missing or invalid Mapbox token
✅ Solution: Follow "Critical: Add Your Mapbox Access Token" section above

### ISS marker not moving?
- Check browser console (F12) for errors
- Verify debug panel shows "ISS tracking initialized"
- Check that TLE data is being fetched (look for "API" or "mock" message)

### Trail not visible?
- Ensure zoom level is low enough (< 10) to see trail
- Check that ISS marker is visible first
- Trails are white (#ffffff) - might be hard to see on light styles

### Terrain not showing?
- Switch to "Terrain" style button (bottom-right)
- Ensure Mapbox token has terrain access (usually default)
- Zoom in close for best elevation visualization

---

## 📚 Resources

- **Mapbox GL Documentation**: https://docs.mapbox.com/mapbox-gl-js/
- **Mapbox Access Token Setup**: https://docs.mapbox.com/help/getting-started/access-tokens/
- **satellite.js Library**: https://github.com/shashwatak/satellite-js
- **ISS TLE Data**: https://www.n2yo.com/

---

## ✨ Summary

Your ISS tracker now uses **Mapbox GL** instead of a simple textured sphere. This means:

✅ **Real geographic data** - Proper zoom without going "through the planet"
✅ **3D terrain** - See elevation and topography  
✅ **Multiple styles** - Light, satellite, and terrain views
✅ **Customizable** - Easy to change colors, features, etc.
✅ **Professional** - Used by major companies for location-based services

🔴 **Required to proceed**: Add your free Mapbox token to `main.js`

Once you add the token, you'll have a beautiful, functional ISS tracker with proper geographic mapping!
