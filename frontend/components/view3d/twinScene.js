// The Cesium scene of one recorded SUMO run. All geometry comes from the Lab API. Objects are created once and reused;
// theme changes and motion update them in place, and destroy() frees everything including the WebGL context.
import { signalColor } from './frameBuffer.js';
import { QUALITY, QualityController } from './quality.js';
import { toSceneTheme } from './sceneTheme.js';
import { vehicleGltf } from './vehicleModel.js';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
const BASEMAPS = {
  dark: `${ESRI}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
  light: `${ESRI}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
};
const NEAR_MODEL_RANGE_M = 300;
// Density bands in vehicles per km per lane. Display conventions, not a traffic-engineering standard.
const DENSITY_MID = 25, DENSITY_HIGH = 60;
const HEAT_LEVEL = { light: 0, heavy: 1, severe: 2 };

function glowImage() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const c = canvas.getContext('2d');
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'white');
  g.addColorStop(1, 'transparent');
  c.fillStyle = g;
  c.fillRect(0, 0, 64, 64);
  return canvas;
}

function arrowImage() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const c = canvas.getContext('2d');
  c.fillStyle = 'white';   // Tinted per theme through the billboard color.
  c.beginPath();
  c.moveTo(16, 2); c.lineTo(28, 30); c.lineTo(16, 23); c.lineTo(4, 30);
  c.closePath();
  c.fill();
  return canvas;
}

export function createTwinScene(Cesium, container, network, { onPick, onRenderError }) {
  const { BillboardCollection, BoundingSphere, Cartesian3, CesiumWidget, Credit, EasingFunction, HeadingPitchRange, HeadingPitchRoll,
    HorizontalOrigin, ImageryLayer, LabelCollection, Material, Math: CesiumMath, Matrix4, Model, NearFarScalar,
    PointPrimitiveCollection, PolylineCollection, ScreenSpaceEventHandler, ScreenSpaceEventType, Color, SceneMode,
    Transforms, UrlTemplateImageryProvider, VerticalOrigin, DistanceDisplayCondition } = Cesium;

  const widget = new CesiumWidget(container, {
    baseLayer: false,
    skyBox: false,
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
    showRenderLoopErrors: false,
    sceneMode: SceneMode.SCENE3D,
  });
  const { scene, camera, canvas } = widget;
  scene.fog.enabled = false;
  scene.sun = undefined;
  scene.moon = undefined;
  scene.globe.showGroundAtmosphere = false;
  scene.globe.enableLighting = false;
  scene.screenSpaceCameraController.minimumZoomDistance = 15;
  scene.screenSpaceCameraController.maximumZoomDistance = 30000;

  // Network metres to world coordinates, through the local frame the backend computed.
  const { anchor, transform: tf } = network;
  const origin = Cartesian3.fromDegrees(anchor.lon, anchor.lat);
  const enu = Transforms.eastNorthUpToFixedFrame(origin);
  const scratchLocal = new Cartesian3();
  const toWorld = (x, y, up, result = new Cartesian3()) => {
    const dx = x - tf.cx, dy = y - tf.cy;
    scratchLocal.x = tf.ee * dx + tf.en * dy;
    scratchLocal.y = tf.ne * dx + tf.nn * dy;
    scratchLocal.z = up;
    return Matrix4.multiplyByPoint(enu, scratchLocal, result);
  };
  const bounds = network.bounds;
  const networkRadius = bounds ? Math.max(120, Math.hypot(bounds.max_x - bounds.min_x, bounds.max_y - bounds.min_y) / 2) : 500;

  // Roads: a casing, a center line and a density overlay per edge.
  const roads = scene.primitives.add(new PolylineCollection());
  const addRoad = (edge, up, width, show = true) => roads.add({
    positions: edge.shape.map(([x, y]) => toWorld(x, y, up)),
    width,
    show,
    material: Material.fromType('Color', { color: Color.WHITE.clone() }),
  });
  const usable = network.edges.map(edge => (edge.shape.length >= 2 ? edge : null));
  const casings = [], centers = [];
  const densityLines = new Array(network.edges.length).fill(null);
  usable.forEach((edge, i) => {
    if (!edge) return;
    casings.push(addRoad(edge, 0.3, Math.min(10, 3 + edge.lanes * 2)));
    centers.push(addRoad(edge, 0.4, 1));
    densityLines[i] = addRoad(edge, 0.5, Math.min(6, 2 + edge.lanes), false);
  });
  const densityBand = new Int8Array(network.edges.length).fill(-1);
  const edgeCounts = new Uint16Array(network.edges.length);

  // Intersections, signal lamps, heat glows and identifiers.
  const points = scene.primitives.add(new PointPrimitiveCollection());
  const glows = scene.primitives.add(new BillboardCollection());
  const labels = scene.primitives.add(new LabelCollection());
  const glowCanvas = glowImage();
  const junctions = new Map();
  for (const signal of network.signals) {
    if (signal.x === null || signal.x === undefined) continue;
    const position = toWorld(signal.x, signal.y, 1);
    const pick = { kind: 'junction', id: signal.id };
    junctions.set(signal.id, {
      signal,
      position,
      marker: points.add({ position, pixelSize: 11, outlineWidth: 2, id: pick }),
      lamps: signal.lamps.map(lamp => ({
        links: lamp.links,
        color: null,
        point: points.add({ position: toWorld(lamp.at[0], lamp.at[1], 1.5), pixelSize: 6, scaleByDistance: new NearFarScalar(200, 1.3, 6000, 0.5), id: pick }),
      })),
      glow: glows.add({ position: toWorld(signal.x, signal.y, 0.2), image: glowCanvas, width: 240, height: 240, sizeInMeters: true, show: false, id: pick }),
      glowLevel: null,
      label: labels.add({
        position: toWorld(signal.x, signal.y, 4),
        text: signal.id.length > 22 ? `${signal.id.slice(0, 21)}…` : signal.id,
        scale: 0.5,
        pixelOffset: new Cesium.Cartesian2(0, -14),
        horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new DistanceDisplayCondition(0, 2400),
        show: false,
      }),
    });
  }

  // Vehicles: a pool of billboards, plus a few models when the camera is close and quality allows.
  const billboards = scene.primitives.add(new BillboardCollection());
  const arrow = arrowImage();
  const active = new Map();
  const free = [];
  const models = [];
  const modelFor = new Map();
  let modelsReady = false;
  let theme = null;
  let level = 'high';
  let settings = QUALITY.high;
  let manualQuality = false;
  const controller = new QualityController('high');
  const layers = { vehicles: true, signals: true, density: true, heatmap: true, labels: true, roads: true };
  const allowed = { vehicles: true, signals: true, density: true, heatmap: true, labels: true, roads: true };
  const on = name => layers[name] && allowed[name];

  const newVehicle = id => {
    const item = free.pop() || { billboard: billboards.add({ image: arrow, width: 14, height: 14, position: origin, alignedAxis: Cartesian3.UNIT_Z }), id: null, emergency: false };
    item.id = id;
    item.emergency = false;
    item.pick = { kind: 'vehicle', id };
    item.billboard.id = item.pick;
    item.billboard.show = true;
    if (theme) item.billboard.color = theme.vehicle;
    active.set(id, item);
    return item;
  };

  const loadModels = async () => {
    const gltf = vehicleGltf();
    try {
      for (let i = 0; i < QUALITY.high.nearModels; i++) {
        const model = await Model.fromGltfAsync({ gltf: structuredClone(gltf), show: false, scene, minimumPixelSize: 0, incrementallyLoadTextures: false, allowPicking: true });
        if (scene.isDestroyed()) return;
        scene.primitives.add(model);
        if (theme) model.color = theme.vehicle;
        models.push(model);
      }
      modelsReady = true;
    } catch (err) {
      console.warn('3D View: vehicle models unavailable, using glyphs only', err?.message);
    }
  };
  loadModels();

  // Basemap only for networks with a real location: a synthetic grid must not appear to be on a real street.
  let basemap = null, basemapKind = null;
  const applyBasemap = () => {
    if (!network.geo || !theme) return;
    const kind = theme.mapBase === 'light' ? 'light' : 'dark';
    if (kind !== basemapKind) {
      if (basemap) scene.imageryLayers.remove(basemap, true);
      basemap = ImageryLayer.fromProviderAsync(Promise.resolve(new UrlTemplateImageryProvider({
        url: BASEMAPS[kind],
        maximumLevel: 16,
        credit: new Credit('Tiles © Esri, HERE, Garmin, © OpenStreetMap contributors'),
      })));
      scene.imageryLayers.add(basemap);
      basemapKind = kind;
    }
    basemap.alpha = theme.basemapAlpha;
  };

  const applySignals = frame => {
    if (!theme || !frame) return;
    for (const [id, junction] of junctions) {
      const state = frame.tl[id]?.[1];
      for (const lamp of junction.lamps) {
        const color = signalColor(state, lamp.links);
        if (color !== lamp.color) {
          lamp.color = color;
          lamp.point.color = theme.signals[color];
        }
      }
    }
  };

  const applyJunctionLevels = measured => {
    if (!theme) return;
    for (const [id, junction] of junctions) {
      const level_ = measured.get(id)?.[2];
      const heat = HEAT_LEVEL[level_];
      if (heat === undefined) {
        junction.glow.show = false;
        junction.glowLevel = null;
        continue;
      }
      junction.glowLevel = heat;
      junction.glow.show = on('heatmap') && settings.heat;
      junction.glow.color = Color.fromAlpha(theme.heat[heat], 0.55, junction.glow.color);
    }
  };

  // Only roads with vehicles on them are colored, so an empty road keeps its normal look.
  const applyDensity = counts => {
    for (let i = 0; i < densityLines.length; i++) {
      const line = densityLines[i];
      if (!line) continue;
      const edge = network.edges[i];
      const perKmLane = counts[i] / Math.max(0.01, (edge.length / 1000) * edge.lanes);
      const band = counts[i] === 0 ? -1 : perKmLane >= DENSITY_HIGH ? 2 : perKmLane >= DENSITY_MID ? 1 : 0;
      if (band !== densityBand[i]) {
        densityBand[i] = band;
        line.show = band >= 0 && on('density');
        if (band >= 0 && theme) line.material.uniforms.color = theme.heat[band];
      }
    }
  };

  const applyLayerVisibility = () => {
    casings.forEach(line => { line.show = on('roads'); });
    centers.forEach(line => { line.show = on('roads'); });
    densityLines.forEach((line, i) => { if (line) line.show = on('density') && densityBand[i] >= 0; });
    for (const junction of junctions.values()) {
      junction.lamps.forEach(lamp => { lamp.point.show = on('signals'); });
      junction.glow.show = on('heatmap') && settings.heat && junction.glowLevel !== null;
      junction.label.show = on('labels') && settings.labels;
    }
    if (!on('vehicles')) {
      for (const item of active.values()) item.billboard.show = false;
      for (const model of models) model.show = false;
    }
    scene.requestRender();
  };

  const applyQuality = next => {
    level = next;
    settings = QUALITY[next];
    widget.useBrowserRecommendedResolution = false;
    widget.resolutionScale = settings.resolution === 'device' ? window.devicePixelRatio || 1 : settings.resolution;
    scene.msaaSamples = settings.msaa;
    if (scene.skyAtmosphere && theme) scene.skyAtmosphere.show = theme.atmosphere && settings.atmosphere;
    applyLayerVisibility();
  };

  const applyTheme = tokens => {
    theme = toSceneTheme(tokens, Color);
    scene.backgroundColor = theme.background;
    scene.globe.baseColor = theme.ground;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = theme.atmosphere && settings.atmosphere;
    casings.forEach(line => { line.material.uniforms.color = theme.roadCasing; });
    centers.forEach(line => { line.material.uniforms.color = theme.roadCenter; });
    densityLines.forEach((line, i) => { if (line && densityBand[i] >= 0) line.material.uniforms.color = theme.heat[densityBand[i]]; });
    for (const junction of junctions.values()) {
      junction.marker.color = theme.marker;
      junction.marker.outlineColor = theme.markerOutline;
      junction.lamps.forEach(lamp => { if (lamp.color) lamp.point.color = theme.signals[lamp.color]; else lamp.point.color = theme.signals.red; });
      if (junction.glowLevel !== null) junction.glow.color = Color.fromAlpha(theme.heat[junction.glowLevel], 0.55, junction.glow.color);
      junction.label.font = `600 28px ${theme.font}`;
      junction.label.fillColor = theme.label;
      junction.label.outlineColor = theme.markerOutline;
      junction.label.outlineWidth = 3;
      junction.label.style = Cesium.LabelStyle.FILL_AND_OUTLINE;
    }
    for (const item of active.values()) item.billboard.color = item.emergency ? theme.emergency : theme.vehicle;
    for (const model of models) model.color = theme.vehicle;
    applyBasemap();
    scene.requestRender();
  };

  // ------------------------------------------------------------ per-frame update
  const seen = new Set();
  const scratchWorld = new Cartesian3();
  const scratchAxis = new Cartesian3();
  const scratchFollow = new Cartesian3();
  const scratchHpr = new HeadingPitchRoll();
  const followPosition = new Cartesian3();
  const selected = { kind: null, id: null };
  let following = false, followReady = false, vehicleGone = false;
  let drawn = 0, total = 0;
  let modelsUsed = 0;
  const nearest = [];
  const vehicleInfo = { id: null, speed: 0, angle: 0, waiting: 0, type: null };

  // Takes the buffer so geometry is only touched while the playhead actually moves.
  const update = (buffer, t) => {
    seen.clear();
    drawn = 0;
    total = 0;
    edgeCounts.fill(0);
    nearest.length = 0;
    let selectedSeen = false;
    const cameraPosition = camera.positionWC;
    const showVehicles = on('vehicles');
    const useModels = modelsReady && settings.nearModels > 0 && showVehicles;
    const result = buffer.sample(t, (id, x, y, angle, speed, waiting, type, edge) => {
      total += 1;
      if (edge >= 0) edgeCounts[edge] += 1;
      if (selected.kind === 'vehicle' && selected.id === id) {
        selectedSeen = true;
        vehicleInfo.id = id; vehicleInfo.speed = speed; vehicleInfo.angle = angle; vehicleInfo.waiting = waiting; vehicleInfo.type = type;
        toWorld(x, y, 0, scratchFollow);
        if (following) {
          if (followReady) {
            const dx = scratchFollow.x - followPosition.x, dy = scratchFollow.y - followPosition.y, dz = scratchFollow.z - followPosition.z;
            camera.position.x += dx; camera.position.y += dy; camera.position.z += dz;
          }
          Cartesian3.clone(scratchFollow, followPosition);
          followReady = true;
        }
      }
      if (!showVehicles || drawn >= settings.maxVehicles) return;
      seen.add(id);
      drawn += 1;
      const item = active.get(id) || newVehicle(id);
      toWorld(x, y, 1.2, scratchWorld);
      item.billboard.position = scratchWorld;
      const rad = CesiumMath.toRadians(angle);
      scratchLocal.x = Math.sin(rad);
      scratchLocal.y = Math.cos(rad);
      scratchLocal.z = 0;
      Matrix4.multiplyByPointAsVector(enu, scratchLocal, scratchAxis);
      Cartesian3.normalize(scratchAxis, scratchAxis);
      item.billboard.alignedAxis = scratchAxis;
      const emergency = /ambulance|emergency/i.test(type || '');
      if (emergency !== item.emergency && theme) {
        item.emergency = emergency;
        item.billboard.color = emergency ? theme.emergency : theme.vehicle;
      }
      item.x = x; item.y = y; item.angle = angle;
      if (useModels) {
        const distance = Cartesian3.distance(scratchWorld, cameraPosition);
        if (distance < NEAR_MODEL_RANGE_M) nearest.push(item, distance);
      }
    });
    if (!result) return null;
    if (selected.kind === 'vehicle' && !selectedSeen) {
      vehicleInfo.id = null;
      vehicleGone = true;
      following = false;
    }

    for (const [id, item] of active) {
      if (!seen.has(id)) {
        item.billboard.show = false;
        item.id = null;
        free.push(item);
        active.delete(id);
      }
    }

    // The closest vehicles become 3D models, and their glyphs hide.
    for (let i = 0; i < models.length; i++) models[i].show = false;
    modelsUsed = 0;
    for (const item of modelFor.keys()) if (item.billboard) item.billboard.show = item.id !== null && showVehicles;
    modelFor.clear();
    if (useModels && nearest.length) {
      for (let i = 0; i < nearest.length && modelsUsed < settings.nearModels; i += 2) {
        const item = nearest[i];
        const model = models[modelsUsed++];
        toWorld(item.x, item.y, 0.2, scratchWorld);
        // SUMO angles run clockwise from north, as Cesium headings do. The model's front is -Z, turned by a half circle.
        scratchHpr.heading = CesiumMath.toRadians(item.angle);
        Transforms.headingPitchRollToFixedFrame(scratchWorld, scratchHpr, undefined, undefined, model.modelMatrix);
        model.color = item.emergency ? theme.emergency : theme.vehicle;
        model.id = item.pick;
        model.show = true;
        item.billboard.show = false;
        modelFor.set(item, model);
      }
    }

    buffer.updateJunctions(t);
    applySignals(result.frame);
    if (buffer.junctionTime !== applied) {
      applied = buffer.junctionTime;
      applyJunctionLevels(buffer.junctions);
    }
    if (result.frame.t !== densityFrame) {
      densityFrame = result.frame.t;
      applyDensity(edgeCounts);
    }
    scene.requestRender();
    return result;
  };
  let applied = null, densityFrame = null;

  // ------------------------------------------------------------ picking and camera
  const handler = new ScreenSpaceEventHandler(canvas);
  handler.setInputAction(click => {
    const picked = scene.pick(click.position);
    const id = picked?.id ?? picked?.primitive?.id;
    if (id && id.kind) {
      select(id.kind, id.id);
      onPick({ kind: id.kind, id: id.id });
    } else {
      select(null, null);
      onPick(null);
    }
  }, ScreenSpaceEventType.LEFT_CLICK);

  const select = (kind, id) => {
    selected.kind = kind;
    selected.id = id;
    vehicleInfo.id = null;
    vehicleGone = false;
    following = false;
    followReady = false;
    scene.requestRender();
  };

  const flyTo = (center, radius, duration = 0.9) => {
    camera.cancelFlight();
    camera.flyToBoundingSphere(new BoundingSphere(center, radius), {
      duration,
      offset: new HeadingPitchRange(0, CesiumMath.toRadians(-48), radius * 2.4),
      easingFunction: EasingFunction.QUADRATIC_IN_OUT,
    });
  };

  const resetCamera = (duration = 0.9) => {
    following = false;
    followReady = false;
    const center = bounds ? toWorld((bounds.min_x + bounds.max_x) / 2, (bounds.min_y + bounds.max_y) / 2, 0) : origin;
    flyTo(center, networkRadius, duration);
  };
  resetCamera(0);

  // ------------------------------------------------------------ measurement
  let frames = 0, windowStart = performance.now(), fps = 0, renderMs = 0, lastFrame = 0;
  const removeFrameListener = scene.postRender.addEventListener(() => {
    const now = performance.now();
    if (lastFrame) renderMs = now - lastFrame;
    lastFrame = now;
    frames += 1;
  });
  const statsTimer = setInterval(() => {
    const now = performance.now();
    const seconds = (now - windowStart) / 1000;
    fps = Math.round(frames / seconds);
    if (!manualQuality && !document.hidden && frames > 3) {
      const change = controller.observe(fps, seconds);
      if (change) applyQuality(change);
    }
    frames = 0;
    windowStart = now;
  }, 1000);
  const removeErrorListener = scene.renderError.addEventListener((_, error) => onRenderError(error));

  applyQuality('high');

  return {
    applyTheme,
    update,
    resetCamera,
    zoom(direction) {
      const height = camera.positionCartographic.height;
      camera.zoomIn(direction * height * 0.35);
      scene.requestRender();
    },
    setLayer(name, value) { layers[name] = value; applyLayerVisibility(); },
    setAllowed(next) { Object.assign(allowed, next); applyLayerVisibility(); },
    setQuality(value) {
      manualQuality = value !== 'auto';
      if (manualQuality) applyQuality(value);
    },
    focusJunction(id) {
      const junction = junctions.get(id);
      if (junction) flyTo(junction.position, 90);
    },
    focusPoint(x, y) { flyTo(toWorld(x, y, 0), 60); },
    select,
    setFollow(value) {
      followReady = false;
      following = false;
      camera.cancelFlight();
      if (!value || selected.kind !== 'vehicle' || !vehicleInfo.id) return;
      // Move in close first; from then on the camera travels with the vehicle and the user can still orbit or zoom.
      camera.flyToBoundingSphere(new BoundingSphere(Cartesian3.clone(scratchFollow), 45), {
        duration: 0.7,
        offset: new HeadingPitchRange(camera.heading, CesiumMath.toRadians(-35), 110),
        complete: () => { following = selected.kind === 'vehicle'; followReady = false; },
      });
    },
    isFollowing: () => following,
    vehicleInfo: () => (vehicleInfo.id ? { ...vehicleInfo } : null),
    vehicleGone: () => vehicleGone,
    junctionInfo: id => junctions.get(id)?.signal ?? null,
    stats: () => ({ fps, frameMs: renderMs, drawn, total, models: modelsUsed, intersections: junctions.size, quality: level, label: QUALITY[level].label, auto: !manualQuality }),
    destroy() {
      clearInterval(statsTimer);
      removeFrameListener();
      removeErrorListener();
      handler.destroy();
      camera.cancelFlight();
      widget.destroy();
      // Browsers cap live WebGL contexts, so release this one rather than waiting for garbage collection.
      (canvas.getContext('webgl2') || canvas.getContext('webgl'))?.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
