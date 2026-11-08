// Pure camera math shared by the local map and its regression tests.
export const MAP_WIDTH = 800;
export const MAP_HEIGHT = 630;
export const MAX_ZOOM = 8;
export const fitCamera = () => ({ x: 0, y: 0, zoom: 1 });
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
export function boundCamera(camera) {
  const zoom = clamp(Number.isFinite(camera.zoom) ? camera.zoom : 1, 1, MAX_ZOOM);
  return { zoom,
    x: clamp(Number.isFinite(camera.x) ? camera.x : 0, 0, MAP_WIDTH - MAP_WIDTH / zoom),
    y: clamp(Number.isFinite(camera.y) ? camera.y : 0, 0, MAP_HEIGHT - MAP_HEIGHT / zoom) };
}
export function zoomCamera(camera, factor, anchor = null) {
  const current = boundCamera(camera);
  if (!Number.isFinite(factor) || factor <= 0) return current;
  const zoom = clamp(current.zoom * factor, 1, MAX_ZOOM);
  const point = anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y) ? anchor : {
    x: current.x + MAP_WIDTH / current.zoom / 2, y: current.y + MAP_HEIGHT / current.zoom / 2 };
  return boundCamera({ zoom,
    x: point.x - (point.x - current.x) * current.zoom / zoom,
    y: point.y - (point.y - current.y) * current.zoom / zoom });
}
export function panCamera(camera, dx, dy) {
  const current = boundCamera(camera);
  return boundCamera({ ...current, x: current.x + (Number.isFinite(dx) ? dx : 0), y: current.y + (Number.isFinite(dy) ? dy : 0) });
}
export function viewBox(camera) {
  const c = boundCamera(camera);
  return `${c.x} ${c.y} ${MAP_WIDTH / c.zoom} ${MAP_HEIGHT / c.zoom}`;
}
export function fitBounds(bounds, padding = 40) {
  if (!bounds || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(bounds[k])) || bounds.width <= 0 || bounds.height <= 0) return fitCamera();
  const pad = Number.isFinite(padding) ? clamp(padding, 0, 200) : 40;
  const zoom = clamp(Math.min((MAP_WIDTH - 2 * pad) / bounds.width, (MAP_HEIGHT - 2 * pad) / bounds.height), 1, MAX_ZOOM);
  return boundCamera({ zoom, x: bounds.x + bounds.width / 2 - MAP_WIDTH / zoom / 2,
    y: bounds.y + bounds.height / 2 - MAP_HEIGHT / zoom / 2 });
}
